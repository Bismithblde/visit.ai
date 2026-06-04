import { getSourceType, sourceQualityScore } from "@/lib/activity-discovery/source-quality";
import { TavilyDiscoveryTool } from "@/lib/activity-discovery/tavily-tool";
import { buildSearchCacheKey, cleanWhitespace, normalizeActivityName, normalizePlace } from "./normalize";
import { parsePreferences } from "./preferences";
import type {
  ActivityRequest,
  ActivitySourceKind,
  ActivityTagName,
  ParsedPreference,
  SearchCandidate,
} from "./types";

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilySearchDeps {
  getCached<T>(key: string): Promise<T | null>;
  setCached<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  saveSearchResult(input: {
    query: string;
    normalizedQueryKey: string;
    city: string;
    results: unknown;
    expiresAt: Date;
  }): Promise<void>;
}

export async function runTavilyFallback(
  request: ActivityRequest,
  parsed: ParsedPreference,
  deps: TavilySearchDeps,
) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("Missing TAVILY_API_KEY");
  }

  const tool = new TavilyDiscoveryTool(apiKey);
  const queries = buildTavilyQueries(request, parsed);
  const resultSets = await Promise.all(
    queries.map(async (query) => {
      const cacheKey = buildSearchCacheKey(query);
      const cached = await deps.getCached<TavilySearchResult[]>(cacheKey);

      if (cached) {
        return { query, results: cached };
      }

      const results = await tool.web_search(query, 5);
      await deps.setCached(cacheKey, results, 60 * 60 * 24);
      await deps.saveSearchResult({
        query,
        normalizedQueryKey: cacheKey,
        city: request.city,
        results,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
      });
      return { query, results };
    }),
  );

  const candidates = dedupeSearchCandidates(
    resultSets.flatMap(({ query, results }) =>
      rankSearchResults(results)
        .slice(0, 4)
        .map((result) => searchResultToCandidate(request, parsed, query, result))
        .filter((candidate): candidate is SearchCandidate => Boolean(candidate)),
    ),
  ).slice(0, 18);

  return { queries, candidates };
}

export function buildTavilyQueries(
  request: ActivityRequest,
  parsed = parsePreferences(request),
) {
  const city = request.city;
  const topTags = parsed.importantTags.slice(0, 2);
  const queries = [
    `${city} hidden gems reddit`,
    topTags.includes("food")
      ? `${city} local favorite food activities`
      : `${city} unique activities local guide`,
    topTags.includes("free") || topTags.includes("cheap")
      ? `${city} best free things to do`
      : `${city} best things to do local guide`,
    ...topTags.map((tag) => `${city} ${tag.replace("_", " ")} things to do`),
  ];

  return uniqueStrings(queries.map(cleanWhitespace).filter(Boolean)).slice(0, 5);
}

function searchResultToCandidate(
  request: ActivityRequest,
  parsed: ParsedPreference,
  query: string,
  result: TavilySearchResult,
): SearchCandidate | null {
  if (!isHttpUrl(result.url)) return null;

  const title = cleanTitle(result.title);
  if (!title || title.length < 3) return null;

  const sourceType = mapSourceType(result.url);
  const text = `${title} ${result.content} ${query}`.toLowerCase();
  const tags = inferTags(text, parsed);
  const confidenceScore = clamp01(
    result.score * 0.45 + sourceQualityScore(result.url) * 0.4 + Math.min(tags.length / 5, 1) * 0.15,
  );

  return {
    name: title,
    normalizedName: normalizeActivityName(title, request.city),
    city: normalizePlace(request.city),
    region: request.region ? normalizePlace(request.region) : undefined,
    country: request.country ? normalizePlace(request.country) : undefined,
    description: cleanWhitespace(result.content || result.title).slice(0, 360),
    tags,
    source: {
      sourceType,
      url: result.url,
      title: result.title,
      snippet: cleanWhitespace(result.content).slice(0, 500),
      queryUsed: query,
      confidence: clamp01(sourceQualityScore(result.url)),
    },
    priceLevel: priceFromTags(tags),
    confidenceScore,
  };
}

function inferTags(text: string, parsed: ParsedPreference): ActivityTagName[] {
  const tags = new Set<ActivityTagName>();

  for (const tag of parsed.importantTags) {
    tags.add(tag);
  }

  const keywordTags: Array<[ActivityTagName, string[]]> = [
    ["food", ["food", "restaurant", "eat", "dining", "cafe", "market"]],
    ["outdoor", ["outdoor", "park", "hike", "garden", "beach"]],
    ["museum", ["museum", "gallery", "exhibit"]],
    ["nightlife", ["nightlife", "bar", "club", "karaoke"]],
    ["shopping", ["shopping", "shop", "boutique"]],
    ["scenic", ["scenic", "view", "waterfront", "sunset"]],
    ["free", ["free"]],
    ["cheap", ["cheap", "budget", "affordable"]],
    ["local_favorite", ["local", "locals", "neighborhood"]],
    ["hidden_gem", ["hidden", "underrated", "offbeat", "secret"]],
    ["touristy", ["tourist", "popular attraction"]],
    ["romantic", ["romantic", "date night", "couple"]],
    ["family_friendly", ["family", "kids", "children"]],
    ["rainy_day", ["indoor", "rainy"]],
    ["walking", ["walk", "walking", "stroll"]],
    ["unique", ["unique", "unusual", "weird"]],
    ["seasonal", ["seasonal", "festival", "holiday"]],
  ];

  for (const [tag, keywords] of keywordTags) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      tags.add(tag);
    }
  }

  return [...tags].slice(0, 8);
}

function rankSearchResults(results: TavilySearchResult[]) {
  const byUrl = new Map<string, TavilySearchResult>();
  for (const result of results) {
    if (!result.url || genericTravelPage(result)) continue;
    const existing = byUrl.get(result.url);
    if (!existing || result.score > existing.score) byUrl.set(result.url, result);
  }

  return [...byUrl.values()].sort((a, b) => {
    const sourceDiff = sourceQualityScore(b.url) - sourceQualityScore(a.url);
    return sourceDiff || b.score - a.score;
  });
}

function dedupeSearchCandidates(candidates: SearchCandidate[]) {
  const byKey = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.city}:${candidate.normalizedName}`;
    const existing = byKey.get(key);
    if (!existing || candidate.confidenceScore > existing.confidenceScore) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function mapSourceType(url: string): ActivitySourceKind {
  const type = getSourceType(url);
  if (type === "travel_site") return "tourism";
  if (type === "event_page") return "official";
  if (type === "reddit" || type === "local_blog" || type === "review_site" || type === "listicle") {
    return type;
  }
  return "other";
}

function cleanTitle(title: string) {
  return cleanWhitespace(title)
    .replace(/\s[-|]\s.*$/, "")
    .replace(/\b(best|top)\s+\d+\s+/i, "")
    .slice(0, 100);
}

function genericTravelPage(result: TavilySearchResult) {
  const text = `${result.title} ${result.content}`.toLowerCase();
  return text.includes("flights") || text.includes("hotel deals") || text.includes("vacation packages");
}

function priceFromTags(tags: ActivityTagName[]) {
  if (tags.includes("free")) return "free";
  if (tags.includes("cheap")) return "cheap";
  if (tags.includes("expensive")) return "expensive";
  if (tags.includes("mid_price")) return "mid_price";
  return undefined;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
