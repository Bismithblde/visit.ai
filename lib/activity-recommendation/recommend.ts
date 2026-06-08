import { after } from "next/server";
import { getCacheClient, type CacheClient } from "@/lib/redis";
import { TavilyDiscoveryTool } from "@/lib/activity-discovery/tavily-tool";
import { getSourceType } from "@/lib/activity-discovery/source-quality";
import {
  locationCacheKey,
  normalizeLocation,
  toActivityRequestLocation,
} from "@/lib/activities/location";
import {
  buildSearchCacheKey,
  cleanWhitespace,
  normalizeActivityName,
} from "@/lib/activities/normalize";
import { parsePreferences, parseRecommendationInput } from "@/lib/activities/preferences";
import { qualityCheck, rankActivities, toResponseItem } from "@/lib/activities/ranking";
import { candidatesToRecords } from "@/lib/activities/store";
import type {
  ActivityRecord,
  ActivityRecommendationRequest,
  ActivityResponseItem,
  ActivitySourceKind,
  SearchCandidate,
} from "@/lib/activities/types";
import {
  cleanPageToChunks,
  contentHash,
  fetchHtmlPage,
  normalizeUrl,
  type CleanedChunk,
  type FetchedPage,
} from "./content";
import { mapWithConcurrency } from "./concurrency";
import {
  extractionCacheKey,
  extractVerifiedActivities,
  generateSearchQueries,
  requestHash,
} from "./openai";
import {
  ensureLocationHierarchy,
  findInventory,
  saveSearchRun,
  upsertVerifiedCandidates,
} from "./store";

const RECOMMENDATION_TTL_SECONDS = 60 * 10;
const LOCATION_TTL_SECONDS = 60 * 60 * 24;
const PAGE_TTL_SECONDS = 60 * 60 * 24 * 14;
const EXTRACTION_TTL_SECONDS = 60 * 60 * 24 * 30;
const LOCK_TTL_SECONDS = 60 * 5;
const SEARCH_RESULTS_PER_QUERY = 5;
const MAX_FETCHED_PAGES = 10;
const SEARCH_CONCURRENCY = 4;
const FETCH_CONCURRENCY = 6;
const EXTRACTION_CONCURRENCY = 3;

type RecommendationSource = "cache" | "database" | "database+refresh" | "web" | "empty";

export interface RecommendationResponse {
  activities: ActivityResponseItem[];
  source: RecommendationSource;
  debug: {
    requestHash: string;
    locationKey: string;
    searchedQueries: string[];
    fetchedUrls: string[];
    cacheHits: {
      recommendation: boolean;
      locationInventory: boolean;
      pages: number;
      extractions: number;
    };
  };
}

export async function recommendActivities(
  input: unknown,
  deps?: {
    cache?: CacheClient;
  },
) {
  const parsed = parseRecommendationInput(input);
  if (!parsed.ok) {
    return { ok: false as const, error: parsed.error };
  }

  const cache = deps?.cache ?? getCacheClient();
  const location = normalizeLocation(parsed.request.location);
  const activityRequest = {
    ...parsed.activityRequest,
    ...toActivityRequestLocation(location),
  };
  const preferences = parsePreferences(activityRequest);
  const hash = requestHash(parsed.request, location);
  const responseCacheKey = `recommendation:${hash}`;
  const cached = await cache.get<RecommendationResponse>(responseCacheKey);

  if (cached) {
    return {
      ok: true as const,
      response: {
        ...cached,
        source: "cache" as const,
        debug: {
          ...cached.debug,
          cacheHits: { ...cached.debug.cacheHits, recommendation: true },
        },
      },
    };
  }

  await ensureLocationHierarchy(location);

  const localInventory = await getCachedInventory(cache, locationCacheKey(location), async () =>
    findInventory(location, false),
  );
  const localCoverage = qualityCheck(localInventory.records, preferences);
  let inventory = localInventory.records;
  let source: RecommendationSource = "database";
  const searchedQueries: string[] = [];
  const fetchedUrls: string[] = [];
  const cacheHits = {
    recommendation: false,
    locationInventory: localInventory.hit,
    pages: 0,
    extractions: 0,
  };

  if (!localCoverage.isEnough && location.parents.length > 0) {
    const supplemental = await findInventory(location, true);
    inventory = mergeRecords(inventory, supplemental);
  }

  const combinedCoverage = qualityCheck(inventory, preferences);

  if (inventory.length > 0 && combinedCoverage.isEnough) {
    source = isStaleInventory(inventory) ? "database+refresh" : "database";
    if (source === "database+refresh") {
      scheduleRefresh(cache, parsed.request);
    }
  } else {
    const populated = await populateInventory({
      cache,
      request: parsed.request,
      location,
      requestHash: hash,
    });
    searchedQueries.push(...populated.searchedQueries);
    fetchedUrls.push(...populated.fetchedUrls);
    cacheHits.pages += populated.pageCacheHits;
    cacheHits.extractions += populated.extractionCacheHits;
    inventory = mergeRecords(inventory, candidatesToRecords(populated.candidates));
    if (populated.candidates.length > 0) {
      await upsertVerifiedCandidates(location, populated.candidates);
      await cache.del(locationCacheKey(location));
      inventory = await findInventory(location, location.parents.length > 0);
      source = "web";
    } else {
      source = inventory.length > 0 ? "database" : "empty";
    }
  }

  const ranked = rankActivities(inventory, preferences, activityRequest.budget, activityRequest);
  const activities = ranked
    .filter((item) => item.activity.sources.length > 0)
    .slice(0, 24)
    .map((item) => toResponseItem(item.activity, item.score, item.reason));
  const response: RecommendationResponse = {
    activities,
    source: activities.length > 0 ? source : "empty",
    debug: {
      requestHash: hash,
      locationKey: location.normalizedKey,
      searchedQueries,
      fetchedUrls,
      cacheHits,
    },
  };

  if (activities.length > 0) {
    await cache.set(responseCacheKey, response, { ex: RECOMMENDATION_TTL_SECONDS });
  }

  return { ok: true as const, response };
}

async function populateInventory({
  cache,
  request,
  location,
  requestHash: hash,
}: {
  cache: CacheClient;
  request: ActivityRecommendationRequest;
  location: ReturnType<typeof normalizeLocation>;
  requestHash: string;
}) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;

  if (!tavilyKey || !openAiKey) {
    return {
      candidates: [],
      searchedQueries: [],
      fetchedUrls: [],
      pageCacheHits: 0,
      extractionCacheHits: 0,
    };
  }

  const tool = new TavilyDiscoveryTool(tavilyKey);
  const queries = await generateSearchQueries({
    apiKey: openAiKey,
    request,
    location,
  });
  const searchResults = await mapWithConcurrency(queries, SEARCH_CONCURRENCY, async (query) => {
    const cacheKey = buildSearchCacheKey(query);
    const cached = await cache.get<Array<{ title: string; url: string; content: string; score: number }>>(
      cacheKey,
    );
    if (cached) return { query, results: cached };

    const results = await tool.web_search(query, SEARCH_RESULTS_PER_QUERY);
    await cache.set(cacheKey, results, { ex: LOCATION_TTL_SECONDS });
    return { query, results };
  });
  const rankedUrls = dedupeRankedUrls(searchResults.flatMap(({ query, results }) =>
    results.map((result) => ({ ...result, query })),
  )).slice(0, MAX_FETCHED_PAGES);
  const fetched = await mapWithConcurrency(rankedUrls, FETCH_CONCURRENCY, async (result) => {
    try {
      const page = await fetchHtmlPage(result.normalizedUrl);
      await saveSearchRun({
        locationKey: location.normalizedKey,
        requestHash: hash,
        query: result.query,
        normalizedQuery: buildSearchCacheKey(result.query),
        url: page.url,
        normalizedUrl: page.normalizedUrl,
        title: page.title ?? result.title,
        contentHash: page.contentHash,
        status: "fetched",
        fetchedAt: page.fetchedAt,
      });
      return page;
    } catch {
      try {
        const extracted = await tool.extract_page(result.normalizedUrl);
        const html = `<main><h1>${escapeHtml(extracted.title ?? result.title)}</h1><p>${escapeHtml(
          extracted.content,
        )}</p></main>`;
        return {
          url: normalizeUrl(extracted.url),
          normalizedUrl: normalizeUrl(extracted.url),
          title: extracted.title ?? result.title,
          html,
          fetchedAt: new Date(),
          contentHash: hashText(html),
          sourceType: extracted.sourceType,
        } satisfies FetchedPage;
      } catch {
        await saveSearchRun({
          locationKey: location.normalizedKey,
          requestHash: hash,
          query: result.query,
          normalizedQuery: buildSearchCacheKey(result.query),
          url: result.url,
          normalizedUrl: result.normalizedUrl,
          title: result.title,
          status: "failed",
        });
        return null;
      }
    }
  });
  const pages = fetched.filter((page): page is FetchedPage => Boolean(page));
  let pageCacheHits = 0;
  let extractionCacheHits = 0;
  const pageChunks = await mapWithConcurrency(pages, FETCH_CONCURRENCY, async (page) => {
    const cacheKey = `page:${page.contentHash}`;
    const cached = await cache.get<CleanedChunk[]>(cacheKey);
    if (cached) {
      pageCacheHits += 1;
      return { page, chunks: cached };
    }

    const chunks = cleanPageToChunks(page);
    await cache.set(cacheKey, chunks, { ex: PAGE_TTL_SECONDS });
    return { page, chunks };
  });
  const extracted = await mapWithConcurrency(pageChunks, EXTRACTION_CONCURRENCY, async ({ page, chunks }) => {
    const cacheKey = extractionCacheKey(page.contentHash);
    const cached = await cache.get<SearchCandidate[]>(cacheKey);
    if (cached) {
      extractionCacheHits += 1;
      return cached;
    }

    const sourceQuery =
      rankedUrls.find((result) => result.normalizedUrl === page.normalizedUrl)?.query ?? queries[0] ?? "";
    const candidates = await extractVerifiedActivities({
      apiKey: openAiKey,
      request,
      location,
      chunks,
      query: sourceQuery,
    });
    const withSourceTypes = candidates.map((candidate) => ({
      ...candidate,
      source: {
        ...candidate.source,
        sourceType: mapSourceKind(candidate.source.url),
      },
    }));
    await cache.set(cacheKey, withSourceTypes, { ex: EXTRACTION_TTL_SECONDS });
    return withSourceTypes;
  });
  const candidates = dedupeCandidates(extracted.flat());
  const verified = await verifyFallbackCandidates(candidates, tool, location);

  return {
    candidates: verified,
    searchedQueries: queries,
    fetchedUrls: pages.map((page) => page.normalizedUrl),
    pageCacheHits,
    extractionCacheHits,
  };
}

function scheduleRefresh(cache: CacheClient, request: ActivityRecommendationRequest) {
  after(async () => {
    const location = normalizeLocation(request.location);
    const lockKey = `population-lock:${location.normalizedKey}`;
    const locked = await cache.setIfNotExists(lockKey, "1", LOCK_TTL_SECONDS);
    if (!locked) return;

    try {
      await populateInventory({
        cache,
        request,
        location,
        requestHash: requestHash(request, location),
      });
    } finally {
      await cache.del(lockKey);
    }
  });
}

async function getCachedInventory(
  cache: CacheClient,
  key: string,
  loader: () => Promise<ActivityRecord[]>,
) {
  const cached = await cache.get<ActivityRecord[]>(key);
  if (cached) {
    return { hit: true, records: cached.map(reviveActivityRecord) };
  }

  const records = await loader();
  if (records.length > 0) {
    await cache.set(key, records, { ex: LOCATION_TTL_SECONDS });
  }
  return { hit: false, records };
}

function dedupeRankedUrls(
  results: Array<{ title: string; url: string; content: string; score: number; query: string }>,
) {
  const byUrl = new Map<
    string,
    { title: string; url: string; normalizedUrl: string; content: string; score: number; query: string }
  >();

  for (const result of results) {
    try {
      const normalizedUrl = normalizeUrl(result.url);
      const existing = byUrl.get(normalizedUrl);
      if (!existing || result.score > existing.score) {
        byUrl.set(normalizedUrl, { ...result, normalizedUrl });
      }
    } catch {
      continue;
    }
  }

  return [...byUrl.values()].sort((a, b) => b.score - a.score);
}

async function verifyFallbackCandidates(
  candidates: SearchCandidate[],
  tool: TavilyDiscoveryTool,
  location: ReturnType<typeof normalizeLocation>,
) {
  const ambiguous = candidates.filter((candidate) => candidate.needsFallbackVerification);
  if (ambiguous.length === 0) return candidates;

  const checks = await mapWithConcurrency<SearchCandidate, SearchCandidate | null>(
    ambiguous,
    3,
    async (candidate) => {
    const query = `${candidate.name} ${location.canonicalName}`;
    try {
      const results = await tool.web_search(query, 3);
      const support = results.find((result) =>
        `${result.title} ${result.content}`.toLowerCase().includes(candidate.name.toLowerCase().split(" ")[0] ?? ""),
      );
      if (!support) return null;
      return {
        ...candidate,
        confidenceScore: Math.max(candidate.confidenceScore, Math.min(support.score, 0.85)),
        needsFallbackVerification: false,
        source: {
          sourceType: mapSourceKind(support.url),
          url: support.url,
          title: support.title,
          snippet: cleanWhitespace(support.content).slice(0, 700),
          queryUsed: query,
          confidence: Math.min(Math.max(support.score, 0.45), 0.85),
        },
      } satisfies SearchCandidate;
    } catch {
      return null;
    }
  });
  const replacements = new Map(
    checks
      .filter((candidate): candidate is SearchCandidate => Boolean(candidate))
      .map((candidate) => [candidate.normalizedName, candidate]),
  );

  return candidates
    .filter((candidate) => !candidate.needsFallbackVerification || replacements.has(candidate.normalizedName))
    .map((candidate) => replacements.get(candidate.normalizedName) ?? candidate);
}

function dedupeCandidates(candidates: SearchCandidate[]) {
  const byKey = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.city}:${candidate.normalizedName}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    byKey.set(key, {
      ...existing,
      description: longerText(existing.description, candidate.description),
      tags: [...new Set([...existing.tags, ...candidate.tags])],
      confidenceScore: Math.max(existing.confidenceScore, candidate.confidenceScore),
      minGroupSize: minDefined(existing.minGroupSize, candidate.minGroupSize),
      maxGroupSize: maxDefined(existing.maxGroupSize, candidate.maxGroupSize),
      source:
        candidate.confidenceScore > existing.confidenceScore ? candidate.source : existing.source,
      needsFallbackVerification:
        existing.needsFallbackVerification && candidate.needsFallbackVerification,
    });
  }
  return [...byKey.values()].filter((candidate) => candidate.source.url);
}

function mergeRecords(primary: ActivityRecord[], incoming: ActivityRecord[]) {
  const byKey = new Map<string, ActivityRecord>();
  for (const activity of [...primary, ...incoming]) {
    const key = `${activity.city}:${activity.normalizedName}`;
    const existing = byKey.get(key);
    if (!existing || activity.confidenceScore > existing.confidenceScore) {
      byKey.set(key, activity);
    }
  }
  return [...byKey.values()];
}

function isStaleInventory(records: ActivityRecord[]) {
  const newest = records
    .map((record) => record.lastVerifiedAt ?? record.updatedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (!newest) return true;
  return Date.now() - newest.getTime() > 1000 * 60 * 60 * 24 * 14;
}

function reviveActivityRecord(record: ActivityRecord): ActivityRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    lastVerifiedAt: record.lastVerifiedAt ? new Date(record.lastVerifiedAt) : null,
    sources: record.sources.map((source) => ({
      ...source,
      createdAt: new Date(source.createdAt),
    })),
  };
}

function mapSourceKind(url: string): ActivitySourceKind {
  const sourceType = getSourceType(url);
  if (sourceType === "travel_site") return "tourism";
  if (sourceType === "event_page") return "official";
  if (
    sourceType === "reddit" ||
    sourceType === "local_blog" ||
    sourceType === "review_site" ||
    sourceType === "listicle"
  ) {
    return sourceType;
  }
  return "other";
}

function hashText(value: string) {
  return contentHash(value);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function longerText(a: string, b: string) {
  return a.length >= b.length ? a : b;
}

function minDefined(a: number | null | undefined, b: number | null | undefined) {
  if (a == null) return b ?? undefined;
  if (b == null) return a ?? undefined;
  return Math.min(a, b);
}

function maxDefined(a: number | null | undefined, b: number | null | undefined) {
  if (a == null) return b ?? undefined;
  if (b == null) return a ?? undefined;
  return Math.max(a, b);
}
