import { collectDiscoveryContent } from "./content-collector";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fallbackIntentProfile,
  filterAndRankOsmCandidates,
  intentTerms,
  selectOsmCandidatesForReview,
} from "./intent";
import { retrieveGooglePlacesCandidates } from "./google-places";
import {
  fallbackQueries,
  fallbackVerify,
  OpenAIActivityClient,
} from "./openai-activity";
import { buildMergedActivities, finalRankAndDiversify } from "./merge-rank";
import { retrieveOsmCandidates, retrieveTargetedOsmCandidates } from "./osm";
import { verifyOsmCandidatesWithReviews } from "./review-verification";
import {
  resolveBusinessSearchArea,
  type BusinessSearchArea,
} from "./search-area";
import { TavilyDiscoveryTool } from "./tavily-tool";
import type {
  ActivityDiscoveryRequest,
  ActivityDiscoveryItem,
  DiscoveryDebug,
  DiscoveryLocation,
  DiscoveryResponse,
  IntentProfile,
  OSMCandidate,
  PageContent,
  SocialCandidate,
} from "./types";

const SOFT_BUDGET_MS = 43_000;
const DEFAULT_EMPTY_LOCATION: DiscoveryLocation = { query: "" };

export async function discoverActivities(
  request: ActivityDiscoveryRequest,
): Promise<DiscoveryResponse> {
  const tavilyApiKey = process.env.TAVILY_API_KEY;
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const googlePlacesApiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!tavilyApiKey) {
    throw new DiscoveryConfigError("Missing TAVILY_API_KEY");
  }

  if (!openAiApiKey) {
    throw new DiscoveryConfigError("Missing OPENAI_API_KEY");
  }

  const deadline = Date.now() + SOFT_BUDGET_MS;
  const timedOutStages: string[] = [];
  const failedUrls: string[] = [];
  const tavily = new TavilyDiscoveryTool(tavilyApiKey);
  const openAi = new OpenAIActivityClient(openAiApiKey);

  const osmPromise = withStageFallback(
    "osm",
    timedOutStages,
    retrieveOsmCandidates(request),
    { location: { query: request.cityOrLocation }, candidates: [] },
  );
  const planPromise = withStageFallback(
    "openai-query-plan",
    timedOutStages,
    openAi.generateQueryPlan(request),
    {
      queries: fallbackQueries(request),
      relevantOsmCategories: [],
      inferredTags: [],
      intentProfile: fallbackIntentProfile(request),
    },
  );

  const [osmResult, queryPlan] = await Promise.all([osmPromise, planPromise]);
  const businessSearchArea = resolveBusinessSearchArea(
    osmResult.location,
    queryPlan.intentProfile,
    request.searchMode,
  );
  const googlePlacesResult = await retrieveGooglePlacesWithBudget({
    apiKey: googlePlacesApiKey,
    request,
    location: osmResult.location,
    intent: queryPlan.intentProfile,
    searchArea: businessSearchArea,
    deadline,
    timedOutStages,
  });
  const targetedOsm = await retrieveTargetedOsmWithBudget({
    location: osmResult.location,
    intent: queryPlan.intentProfile,
    searchArea: businessSearchArea,
    deadline,
    timedOutStages,
  });
  const osmCandidates = mergeOsmCandidates([
    ...osmResult.candidates,
    ...targetedOsm,
  ]);
  const physicalCandidates = mergePhysicalCandidates([
    ...googlePlacesResult.candidates,
    ...osmCandidates,
  ]);
  await logOsmCandidatesBeforeFiltering({
    request,
    intent: queryPlan.intentProfile,
    broadCandidates: osmResult.candidates,
    targetedCandidates: targetedOsm,
    mergedCandidates: physicalCandidates,
  });
  const remainingAfterPlan = remainingMs(deadline);
  const boundedQueries = queryPlan.queries.slice(0, queryCount(request.searchMode));
  const content = await withTimeout(
    collectDiscoveryContent(request, boundedQueries, tavily),
    Math.min(remainingAfterPlan, contentBudgetMs(request.searchMode)),
    "social-content",
    timedOutStages,
    {
      pages: [] as PageContent[],
      debug: {
        searchedQueries: boundedQueries,
        visitedUrls: [],
        failedUrls: [],
      },
    },
  );

  failedUrls.push(...content.debug.failedUrls);

  const socialCandidates = await extractSocialWithBudget({
    openAi,
    request,
    pages: content.pages,
    deadline,
    timedOutStages,
  });
  const filteredOsm = filterAndRankOsmCandidates(
    physicalCandidates,
    queryPlan.intentProfile,
  );
  const reviewTargets = selectOsmCandidatesForReview(
    filteredOsm,
    queryPlan.intentProfile,
    reviewTargetCount(request.searchMode),
  );
  const reviewResult = await verifyReviewsWithBudget({
    openAi,
    request,
    tavily,
    intent: queryPlan.intentProfile,
    candidates: reviewTargets,
    deadline,
    timedOutStages,
  });
  failedUrls.push(...reviewResult.failedUrls);

  const merged = buildMergedActivities({
    request,
    osmCandidates: filteredOsm.length > 0 ? filteredOsm : physicalCandidates,
    socialCandidates: [...socialCandidates, ...reviewResult.candidates],
  });
  const verified = await verifyWithBudget({
    openAi,
    request,
    activities: merged,
    deadline,
    timedOutStages,
  });
  const activities = finalRankAndDiversify(verified, request);
  const debug = buildDebug({
    searchedQueries: content.debug.searchedQueries,
    visitedUrls: [...content.debug.visitedUrls, ...reviewResult.visitedUrls],
    failedUrls,
    timedOutStages,
    reviewQueries: reviewResult.reviewQueries,
    intentProfile: queryPlan.intentProfile,
    googlePlacesDebug: googlePlacesResult.debug,
    osmCount: osmCandidates.length,
    intentFilteredCount: filteredOsm.length,
    reviewVerifiedCount: reviewResult.candidates.length,
    socialCandidates: [...socialCandidates, ...reviewResult.candidates],
    mergedCount: merged.length,
    returnedCount: activities.length,
  });
  await writeDiscoveryDebugFiles({
    request,
    location: osmResult.location,
    businessSearchArea,
    queryPlan: boundedQueries,
    intent: queryPlan.intentProfile,
    googlePlacesDebug: googlePlacesResult.debug,
    googlePlacesCandidates: googlePlacesResult.candidates,
    osmBroadCandidates: osmResult.candidates,
    osmTargetedCandidates: targetedOsm,
    physicalCandidates,
    filteredCandidates: filteredOsm,
    contentPages: content.pages,
    socialCandidates,
    reviewResult,
    merged,
    verified,
    activities,
    debug,
  });

  return {
    location:
      osmResult.location.query === ""
        ? { ...DEFAULT_EMPTY_LOCATION, query: request.cityOrLocation }
        : osmResult.location,
    queryPlan: boundedQueries,
    activities,
    debug,
  };
}

async function extractSocialWithBudget({
  openAi,
  request,
  pages,
  deadline,
  timedOutStages,
}: {
  openAi: OpenAIActivityClient;
  request: ActivityDiscoveryRequest;
  pages: PageContent[];
  deadline: number;
  timedOutStages: string[];
}) {
  if (pages.length === 0 || remainingMs(deadline) < 2500) {
    if (pages.length > 0) {
      timedOutStages.push("openai-social-extraction");
    }
    return [];
  }

  const batches = chunkPages(pages, 6);
  const results: SocialCandidate[] = [];

  for (const [index, batch] of batches.entries()) {
    if (remainingMs(deadline) < 2500) {
      timedOutStages.push("openai-social-extraction");
      break;
    }

    const extracted = await withTimeout(
      openAi.extractSocialCandidates(request, batch),
      Math.min(remainingMs(deadline), 9000),
      `openai-social-extraction-${index}`,
      timedOutStages,
      [],
    );
    results.push(...extracted);
  }

  return results;
}

async function retrieveGooglePlacesWithBudget({
  apiKey,
  request,
  location,
  searchArea,
  intent,
  deadline,
  timedOutStages,
}: {
  apiKey: string | undefined;
  request: ActivityDiscoveryRequest;
  location: DiscoveryLocation;
  searchArea: BusinessSearchArea;
  intent: IntentProfile;
  deadline: number;
  timedOutStages: string[];
}) {
  if (!apiKey || remainingMs(deadline) < 2500) {
    if (apiKey) {
      timedOutStages.push("google-places");
    }
    return {
      candidates: [] as OSMCandidate[],
      debug: {
        calls: 0,
        estimatedCredits: 0,
        rawCandidates: 0,
        dedupedCandidates: 0,
        queries: [] as string[],
        requestFilters: [] as string[],
        requestBiases: [] as string[],
        errors: [] as string[],
      },
    };
  }

  return withTimeout(
    retrieveGooglePlacesCandidates({ apiKey, request, location, intent, searchArea }),
    Math.min(remainingMs(deadline), googlePlacesBudgetMs(request.searchMode)),
    "google-places",
    timedOutStages,
    {
      candidates: [] as OSMCandidate[],
      debug: {
        calls: 0,
        estimatedCredits: 0,
        rawCandidates: 0,
        dedupedCandidates: 0,
        queries: [] as string[],
        requestFilters: [] as string[],
        requestBiases: [] as string[],
        errors: [] as string[],
      },
    },
  );
}

async function retrieveTargetedOsmWithBudget({
  location,
  intent,
  searchArea,
  deadline,
  timedOutStages,
}: {
  location: DiscoveryLocation;
  intent: IntentProfile;
  searchArea: BusinessSearchArea;
  deadline: number;
  timedOutStages: string[];
}) {
  if (remainingMs(deadline) < 3500) {
    timedOutStages.push("osm-targeted");
    return [] as OSMCandidate[];
  }

  return withTimeout(
    retrieveTargetedOsmCandidates(location, intentTerms(intent), searchArea),
    Math.min(remainingMs(deadline), 4500),
    "osm-targeted",
    timedOutStages,
    [] as OSMCandidate[],
  );
}

async function verifyWithBudget({
  openAi,
  request,
  activities,
  deadline,
  timedOutStages,
}: {
  openAi: OpenAIActivityClient;
  request: ActivityDiscoveryRequest;
  activities: ReturnType<typeof buildMergedActivities>;
  deadline: number;
  timedOutStages: string[];
}) {
  if (activities.length === 0) {
    return [];
  }

  if (remainingMs(deadline) < 3500) {
    timedOutStages.push("openai-verification");
    return fallbackVerify(request, activities);
  }

  const verified = await withTimeout(
    openAi.verifyAndRankActivities({ request, activities }),
    Math.min(remainingMs(deadline), 12_000),
    "openai-verification",
    timedOutStages,
    fallbackVerify(request, activities),
  );

  return verified.length > 0 ? verified : fallbackVerify(request, activities);
}

async function verifyReviewsWithBudget({
  openAi,
  request,
  tavily,
  intent,
  candidates,
  deadline,
  timedOutStages,
}: {
  openAi: OpenAIActivityClient;
  request: ActivityDiscoveryRequest;
  tavily: TavilyDiscoveryTool;
  intent: IntentProfile;
  candidates: OSMCandidate[];
  deadline: number;
  timedOutStages: string[];
}) {
  if (candidates.length === 0 || remainingMs(deadline) < 4500) {
    if (candidates.length > 0) {
      timedOutStages.push("review-verification");
    }
    return {
      candidates: [] as SocialCandidate[],
      reviewQueries: [] as string[],
      visitedUrls: [] as string[],
      failedUrls: [] as string[],
    };
  }

  return withTimeout(
    verifyOsmCandidatesWithReviews({
      openAi,
      request,
      tool: tavily,
      intent,
      candidates,
    }),
    Math.min(remainingMs(deadline), reviewBudgetMs(request.searchMode)),
    "review-verification",
    timedOutStages,
    {
      candidates: [] as SocialCandidate[],
      reviewQueries: [] as string[],
      visitedUrls: [] as string[],
      failedUrls: [] as string[],
    },
  );
}

async function withStageFallback<T>(
  stage: string,
  timedOutStages: string[],
  promise: Promise<T>,
  fallback: T,
) {
  try {
    return await promise;
  } catch {
    timedOutStages.push(stage);
    return fallback;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: string,
  timedOutStages: string[],
  fallback: T,
) {
  if (timeoutMs <= 0) {
    timedOutStages.push(stage);
    return fallback;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          timedOutStages.push(stage);
          resolve(fallback);
        }, timeoutMs);
      }),
    ]);
  } catch {
    timedOutStages.push(stage);
    return fallback;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function buildDebug({
  searchedQueries,
  visitedUrls,
  failedUrls,
  timedOutStages,
  reviewQueries,
  intentProfile,
  googlePlacesDebug,
  osmCount,
  intentFilteredCount,
  reviewVerifiedCount,
  socialCandidates,
  mergedCount,
  returnedCount,
}: {
  searchedQueries: string[];
  visitedUrls: string[];
  failedUrls: string[];
  timedOutStages: string[];
  reviewQueries: string[];
  intentProfile: DiscoveryDebug["intentProfile"];
  googlePlacesDebug: {
    calls: number;
    estimatedCredits: number;
    rawCandidates: number;
    dedupedCandidates: number;
  };
  osmCount: number;
  intentFilteredCount: number;
  reviewVerifiedCount: number;
  socialCandidates: SocialCandidate[];
  mergedCount: number;
  returnedCount: number;
}): DiscoveryDebug {
  const reddit = socialCandidates.filter(
    (candidate) => candidate.sourceType === "reddit",
  ).length;

  return {
    searchedQueries: uniqueStrings(searchedQueries),
    reviewQueries: uniqueStrings(reviewQueries),
    visitedUrls: uniqueStrings(visitedUrls),
    failedUrls: uniqueStrings(failedUrls),
    timedOutStages: uniqueStrings(timedOutStages),
    intentProfile,
    sourceCounts: {
      googlePlaces: googlePlacesDebug.rawCandidates,
      googlePlacesCalls: googlePlacesDebug.calls,
      googlePlacesEstimatedCredits: googlePlacesDebug.estimatedCredits,
      googlePlacesDeduped: googlePlacesDebug.dedupedCandidates,
      googlePlacesEvidenceVerified: socialCandidates.filter((candidate) =>
        candidate.evidenceSummary.toLowerCase().includes("google places"),
      ).length,
      osm: osmCount,
      intentFiltered: intentFilteredCount,
      reviewVerified: reviewVerifiedCount,
      reddit,
      web: socialCandidates.length - reddit,
      merged: mergedCount,
      returned: returnedCount,
    },
  };
}

function chunkPages(pages: PageContent[], size: number) {
  const chunks: PageContent[][] = [];
  for (let index = 0; index < pages.length; index += size) {
    chunks.push(pages.slice(index, index + size));
  }
  return chunks;
}

function queryCount(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 5;
    case "deep":
      return 10;
    default:
      return 8;
  }
}

function contentBudgetMs(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 10_000;
    case "deep":
      return 20_000;
    default:
      return 15_000;
  }
}

function reviewTargetCount(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 6;
    case "deep":
      return 16;
    default:
      return 12;
  }
}

function reviewBudgetMs(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 7000;
    case "deep":
      return 14000;
    default:
      return 10000;
  }
}

function googlePlacesBudgetMs(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 3500;
    case "deep":
      return 8000;
    default:
      return 5500;
  }
}

function remainingMs(deadline: number) {
  return Math.max(0, deadline - Date.now());
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function mergeOsmCandidates(candidates: OSMCandidate[]) {
  const byKey = new Map<string, OSMCandidate>();

  for (const candidate of candidates) {
    const key = `${candidate.osmType}:${candidate.osmId}`;
    if (!byKey.has(key)) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

function mergePhysicalCandidates(candidates: OSMCandidate[]) {
  const byKey = new Map<string, OSMCandidate>();

  for (const candidate of candidates) {
    const provider = candidate.provider ?? "osm";
    const key = `${provider}:${candidate.osmType}:${candidate.osmId}`;
    const fuzzyKey = normalizedPlaceKey(candidate);
    const existingKey = byKey.has(key) ? key : findPhysicalCandidateKey(byKey, fuzzyKey, candidate);

    if (!existingKey) {
      byKey.set(key, candidate);
      continue;
    }

    const existing = byKey.get(existingKey);
    if (!existing || provider === "google_places") {
      byKey.set(existingKey, candidate);
    }
  }

  return [...byKey.values()];
}

function findPhysicalCandidateKey(
  byKey: Map<string, OSMCandidate>,
  fuzzyKey: string,
  incoming: OSMCandidate,
) {
  for (const [key, candidate] of byKey.entries()) {
    if (normalizedPlaceKey(candidate) === fuzzyKey) {
      return key;
    }

    if (geoCloseCandidates(candidate, incoming) && normalizedPlaceKey(candidate).includes(fuzzyKey)) {
      return key;
    }
  }

  return "";
}

function normalizedPlaceKey(candidate: OSMCandidate) {
  return candidate.placeName
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function geoCloseCandidates(a: OSMCandidate, b: OSMCandidate) {
  if (
    typeof a.latitude !== "number" ||
    typeof a.longitude !== "number" ||
    typeof b.latitude !== "number" ||
    typeof b.longitude !== "number"
  ) {
    return false;
  }

  return Math.abs(a.latitude - b.latitude) < 0.001 && Math.abs(a.longitude - b.longitude) < 0.001;
}

async function logOsmCandidatesBeforeFiltering({
  request,
  intent,
  broadCandidates,
  targetedCandidates,
  mergedCandidates,
}: {
  request: ActivityDiscoveryRequest;
  intent: IntentProfile;
  broadCandidates: OSMCandidate[];
  targetedCandidates: OSMCandidate[];
  mergedCandidates: OSMCandidate[];
}) {
  const debugDir = path.join(process.cwd(), ".debug", "activity-discovery");
  const csvPath = path.join(debugDir, "osm-candidates-before-filter.csv");
  const csv = buildOsmDebugCsv({
    request,
    intent,
    broadCandidates,
    targetedCandidates,
    mergedCandidates,
  });

  try {
    await mkdir(debugDir, { recursive: true });
    await writeFile(csvPath, csv, "utf8");
  } catch (error) {
    console.warn(
      "[activities/discover] Failed to write OSM debug CSV",
      error instanceof Error ? error.message : error,
    );
  }

  console.info(
    "[activities/discover] OSM candidates before intent filtering",
    JSON.stringify(
      {
        location: request.cityOrLocation,
        preferencePrompt: request.preferencePrompt,
        intentTerms: intentTerms(intent),
        counts: {
          broad: broadCandidates.length,
          targeted: targetedCandidates.length,
          merged: mergedCandidates.length,
        },
        csvPath,
      },
      null,
      2,
    ),
  );
}

function buildOsmDebugCsv({
  request,
  intent,
  broadCandidates,
  targetedCandidates,
  mergedCandidates,
}: {
  request: ActivityDiscoveryRequest;
  intent: IntentProfile;
  broadCandidates: OSMCandidate[];
  targetedCandidates: OSMCandidate[];
  mergedCandidates: OSMCandidate[];
}) {
  const broadKeys = new Set(
    broadCandidates.map((candidate) => `${candidate.osmType}:${candidate.osmId}`),
  );
  const targetedKeys = new Set(
    targetedCandidates.map((candidate) => `${candidate.osmType}:${candidate.osmId}`),
  );
  const headers = [
    "sourcePass",
    "cityOrLocation",
    "preferencePrompt",
    "intentTerms",
    "placeName",
    "category",
    "osmType",
    "osmId",
    "latitude",
    "longitude",
    "tags",
    "possibleActivities",
    "rawTags",
  ];
  const rows = mergedCandidates.map((candidate) => {
    const key = `${candidate.osmType}:${candidate.osmId}`;
    const sourcePass =
      broadKeys.has(key) && targetedKeys.has(key)
        ? "broad+targeted"
        : targetedKeys.has(key)
          ? "targeted"
          : "broad";

    return [
      sourcePass,
      request.cityOrLocation,
      request.preferencePrompt,
      intentTerms(intent).join(" | "),
      candidate.placeName,
      candidate.category,
      candidate.osmType,
      candidate.osmId,
      candidate.latitude ?? "",
      candidate.longitude ?? "",
      candidate.tags.join(" | "),
      candidate.possibleActivities.join(" | "),
      Object.entries(compactRawTags(candidate.rawTags))
        .map(([key, value]) => `${key}=${value}`)
        .join(" | "),
    ];
  });

  return [headers, ...rows]
    .map((row) => row.map((value) => csvCell(String(value))).join(","))
    .join("\n");
}

async function writeDiscoveryDebugFiles({
  request,
  location,
  businessSearchArea,
  queryPlan,
  intent,
  googlePlacesDebug,
  googlePlacesCandidates,
  osmBroadCandidates,
  osmTargetedCandidates,
  physicalCandidates,
  filteredCandidates,
  contentPages,
  socialCandidates,
  reviewResult,
  merged,
  verified,
  activities,
  debug,
}: {
  request: ActivityDiscoveryRequest;
  location: DiscoveryLocation;
  businessSearchArea: BusinessSearchArea;
  queryPlan: string[];
  intent: IntentProfile;
  googlePlacesDebug: {
    calls: number;
    estimatedCredits: number;
    rawCandidates: number;
    dedupedCandidates: number;
    queries: string[];
    requestFilters: string[];
    requestBiases: string[];
    errors: string[];
  };
  googlePlacesCandidates: OSMCandidate[];
  osmBroadCandidates: OSMCandidate[];
  osmTargetedCandidates: OSMCandidate[];
  physicalCandidates: OSMCandidate[];
  filteredCandidates: OSMCandidate[];
  contentPages: PageContent[];
  socialCandidates: SocialCandidate[];
  reviewResult: {
    candidates: SocialCandidate[];
    reviewQueries: string[];
    visitedUrls: string[];
    failedUrls: string[];
  };
  merged: ActivityDiscoveryItem[];
  verified: ActivityDiscoveryItem[];
  activities: ActivityDiscoveryItem[];
  debug: DiscoveryDebug;
}) {
  const debugDir = path.join(process.cwd(), ".debug", "activity-discovery");
  const summaryPath = path.join(debugDir, "discovery-run-summary.json");
  const latestLogPath = path.join(debugDir, "latest-run.log");
  const appendLogPath = path.join(debugDir, "runs.log");
  const files = {
    latestLog: latestLogPath,
    appendLog: appendLogPath,
    googlePlaces: path.join(debugDir, "01-google-places-candidates.csv"),
    osmBroad: path.join(debugDir, "02-osm-broad-candidates.csv"),
    osmTargeted: path.join(debugDir, "03-osm-targeted-candidates.csv"),
    physicalBeforeFilter: path.join(debugDir, "04-physical-before-filter.csv"),
    physicalAfterFilter: path.join(debugDir, "05-physical-after-filter.csv"),
    socialPages: path.join(debugDir, "06-social-pages.csv"),
    socialCandidates: path.join(debugDir, "07-social-candidates.csv"),
    reviewCandidates: path.join(debugDir, "08-review-candidates.csv"),
    merged: path.join(debugDir, "09-merged-activities.csv"),
    verified: path.join(debugDir, "10-verified-activities.csv"),
    final: path.join(debugDir, "11-final-activities.csv"),
  };

  const summary = {
    writtenAt: new Date().toISOString(),
    request,
    location,
    businessSearchArea,
    queryPlan,
    intent,
    googlePlaces: googlePlacesDebug,
    counts: {
      googlePlacesCandidates: googlePlacesCandidates.length,
      osmBroadCandidates: osmBroadCandidates.length,
      osmTargetedCandidates: osmTargetedCandidates.length,
      physicalBeforeFilter: physicalCandidates.length,
      physicalAfterFilter: filteredCandidates.length,
      contentPages: contentPages.length,
      socialCandidates: socialCandidates.length,
      reviewCandidates: reviewResult.candidates.length,
      merged: merged.length,
      verified: verified.length,
      final: activities.length,
    },
    reviewQueries: reviewResult.reviewQueries,
    visitedReviewUrls: reviewResult.visitedUrls,
    failedReviewUrls: reviewResult.failedUrls,
    debug,
    stages: {
      googlePlacesCandidates: googlePlacesCandidates.map(logCandidate),
      osmBroadCandidates: osmBroadCandidates.map(logCandidate),
      osmTargetedCandidates: osmTargetedCandidates.map(logCandidate),
      physicalBeforeFilter: physicalCandidates.map(logCandidate),
      physicalAfterFilter: filteredCandidates.map(logCandidate),
      socialPages: contentPages.map(logPage),
      socialCandidates: socialCandidates.map(logSocialCandidate),
      reviewCandidates: reviewResult.candidates.map(logSocialCandidate),
      merged: merged.map(logActivity),
      verified: verified.map(logActivity),
      final: activities.map(logActivity),
    },
    files,
  };

  try {
    await mkdir(debugDir, { recursive: true });
    const logText = buildDiscoveryRunLog(summary);
    await Promise.all([
      writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8"),
      writeFile(latestLogPath, logText, "utf8"),
      appendFile(appendLogPath, `${logText}\n${"=".repeat(100)}\n`, "utf8"),
      writeFile(files.googlePlaces, buildCandidateCsv(googlePlacesCandidates), "utf8"),
      writeFile(files.osmBroad, buildCandidateCsv(osmBroadCandidates), "utf8"),
      writeFile(files.osmTargeted, buildCandidateCsv(osmTargetedCandidates), "utf8"),
      writeFile(files.physicalBeforeFilter, buildCandidateCsv(physicalCandidates), "utf8"),
      writeFile(files.physicalAfterFilter, buildCandidateCsv(filteredCandidates), "utf8"),
      writeFile(files.socialPages, buildPageCsv(contentPages), "utf8"),
      writeFile(files.socialCandidates, buildSocialCandidateCsv(socialCandidates), "utf8"),
      writeFile(files.reviewCandidates, buildSocialCandidateCsv(reviewResult.candidates), "utf8"),
      writeFile(files.merged, buildActivityCsv(merged), "utf8"),
      writeFile(files.verified, buildActivityCsv(verified), "utf8"),
      writeFile(files.final, buildActivityCsv(activities), "utf8"),
    ]);
    console.info(
      "[activities/discover] Debug files written",
      JSON.stringify({ summaryPath, files }, null, 2),
    );
  } catch (error) {
    console.warn(
      "[activities/discover] Failed to write discovery debug files",
      error instanceof Error ? error.message : error,
    );
  }
}

function buildDiscoveryRunLog(summary: {
  writtenAt: string;
  request: ActivityDiscoveryRequest;
  location: DiscoveryLocation;
  businessSearchArea: BusinessSearchArea;
  queryPlan: string[];
  intent: IntentProfile;
  googlePlaces: {
    calls: number;
    estimatedCredits: number;
    rawCandidates: number;
    dedupedCandidates: number;
    queries: string[];
    requestFilters: string[];
    requestBiases: string[];
    errors: string[];
  };
  counts: Record<string, number>;
  reviewQueries: string[];
  visitedReviewUrls: string[];
  failedReviewUrls: string[];
  debug: DiscoveryDebug;
  stages: {
    googlePlacesCandidates: string[];
    osmBroadCandidates: string[];
    osmTargetedCandidates: string[];
    physicalBeforeFilter: string[];
    physicalAfterFilter: string[];
    socialPages: string[];
    socialCandidates: string[];
    reviewCandidates: string[];
    merged: string[];
    verified: string[];
    final: string[];
  };
}) {
  return [
    logSection("REQUEST", [
      `time: ${summary.writtenAt}`,
      `cityOrLocation: ${summary.request.cityOrLocation}`,
      `groupSize: ${summary.request.groupSize}`,
      `searchMode: ${summary.request.searchMode}`,
      `dateRange: ${JSON.stringify(summary.request.dateRange ?? null)}`,
      `preferencePrompt: ${summary.request.preferencePrompt}`,
    ]),
    logSection("LOCATION", [
      `query: ${summary.location.query}`,
      `latitude: ${summary.location.latitude ?? "unknown"}`,
      `longitude: ${summary.location.longitude ?? "unknown"}`,
      `nominatimBoundingBox: ${JSON.stringify(summary.location.boundingBox ?? null)}`,
      `nominatimBoundingBoxWidthKm: ${summary.businessSearchArea.bboxWidthKm ?? "unknown"}`,
      `nominatimBoundingBoxHeightKm: ${summary.businessSearchArea.bboxHeightKm ?? "unknown"}`,
      `llmSearchAreaKind: ${summary.intent.searchAreaKind}`,
      `llmRecommendedRadiusMeters: ${summary.intent.recommendedRadiusMeters}`,
      `llmRadiusReason: ${summary.intent.radiusReason}`,
      `businessSearchAreaMode: ${summary.businessSearchArea.mode}`,
      `businessSearchAreaSource: ${summary.businessSearchArea.source}`,
      `businessSearchAreaCenter: ${summary.businessSearchArea.centerLatitude ?? "unknown"},${summary.businessSearchArea.centerLongitude ?? "unknown"}`,
      `businessSearchAreaRequestedRadiusMeters: ${summary.businessSearchArea.requestedRadiusMeters ?? "unknown"}`,
      `businessSearchAreaRadiusMeters: ${summary.businessSearchArea.radiusMeters ?? "unknown"}`,
      `businessSearchAreaReason: ${summary.businessSearchArea.radiusReason}`,
    ]),
    logSection("INTENT", [
      `primaryGoal: ${summary.intent.primaryGoal}`,
      `minimumPreferenceScore: ${summary.intent.minimumPreferenceScore}`,
      `concepts: ${summary.intent.concepts
        .map((concept) => `${concept.term}(${concept.type}:${concept.weight})`)
        .join(", ")}`,
      `placeTypes: ${summary.intent.placeTypes.join(", ") || "none"}`,
      `activityTypes: ${summary.intent.activityTypes.join(", ") || "none"}`,
      `attributes: ${summary.intent.attributes.join(", ") || "none"}`,
      `exclusions: ${summary.intent.exclusions.join(", ") || "none"}`,
      `reviewSearchTerms: ${summary.intent.reviewSearchTerms.join(", ") || "none"}`,
    ]),
    logSection("QUERY PLAN", summary.queryPlan.map((query, index) => `${index + 1}. ${query}`)),
    logSection("GOOGLE PLACES", [
      `calls: ${summary.googlePlaces.calls}`,
      `estimatedCredits: ${summary.googlePlaces.estimatedCredits}`,
      `rawCandidates: ${summary.googlePlaces.rawCandidates}`,
      `dedupedCandidates: ${summary.googlePlaces.dedupedCandidates}`,
      "queries:",
      ...summary.googlePlaces.queries.map((query, index) => `  ${index + 1}. ${query}`),
      "filters:",
      ...summary.googlePlaces.requestFilters.map(
        (filter, index) => `  ${index + 1}. ${filter}`,
      ),
      "biases:",
      ...summary.googlePlaces.requestBiases.map(
        (bias, index) => `  ${index + 1}. ${bias}`,
      ),
      "errors:",
      ...(summary.googlePlaces.errors.length > 0
        ? summary.googlePlaces.errors.map((error, index) => `  ${index + 1}. ${error}`)
        : ["  none"]),
    ]),
    logSection("PIPELINE COUNTS", [
      `googlePlacesCandidates: ${summary.counts.googlePlacesCandidates}`,
      `osmBroadCandidates: ${summary.counts.osmBroadCandidates}`,
      `osmTargetedCandidates: ${summary.counts.osmTargetedCandidates}`,
      `physicalBeforeFilter: ${summary.counts.physicalBeforeFilter}`,
      `physicalAfterFilter: ${summary.counts.physicalAfterFilter}`,
      `contentPages: ${summary.counts.contentPages}`,
      `socialCandidates: ${summary.counts.socialCandidates}`,
      `reviewCandidates: ${summary.counts.reviewCandidates}`,
      `merged: ${summary.counts.merged}`,
      `verified: ${summary.counts.verified}`,
      `final: ${summary.counts.final}`,
    ]),
    logListSection("01 GOOGLE PLACES CANDIDATES", summary.stages.googlePlacesCandidates),
    logListSection("02 OSM BROAD CANDIDATES", summary.stages.osmBroadCandidates),
    logListSection("03 OSM TARGETED CANDIDATES", summary.stages.osmTargetedCandidates),
    logListSection("04 PHYSICAL BEFORE FILTER", summary.stages.physicalBeforeFilter),
    logListSection("05 PHYSICAL AFTER FILTER", summary.stages.physicalAfterFilter),
    logListSection("06 SOCIAL PAGES", summary.stages.socialPages),
    logListSection("07 SOCIAL CANDIDATES", summary.stages.socialCandidates),
    logListSection("08 REVIEW CANDIDATES", summary.stages.reviewCandidates),
    logListSection("09 MERGED ACTIVITIES", summary.stages.merged),
    logListSection("10 VERIFIED ACTIVITIES", summary.stages.verified),
    logListSection("11 FINAL ACTIVITIES", summary.stages.final),
    logSection("REVIEW QUERIES", summary.reviewQueries.length > 0
      ? summary.reviewQueries.map((query, index) => `${index + 1}. ${query}`)
      : ["none"]),
    logSection("REVIEW URLS", [
      "visited:",
      ...(summary.visitedReviewUrls.length > 0
        ? summary.visitedReviewUrls.map((url) => `  ${url}`)
        : ["  none"]),
      "failed:",
      ...(summary.failedReviewUrls.length > 0
        ? summary.failedReviewUrls.map((url) => `  ${url}`)
        : ["  none"]),
    ]),
    logSection("TIMED OUT / FAILED STAGES", summary.debug.timedOutStages.length > 0
      ? summary.debug.timedOutStages
      : ["none"]),
    logSection("SOURCE COUNTS", Object.entries(summary.debug.sourceCounts).map(
      ([key, value]) => `${key}: ${value}`,
    )),
  ].join("\n\n");
}

function logSection(title: string, lines: string[]) {
  return [`# ${title}`, ...lines].join("\n");
}

function logListSection(title: string, values: string[]) {
  return logSection(
    title,
    values.length > 0 ? values.map((value, index) => `${index + 1}. ${value}`) : ["none"],
  );
}

function logCandidate(candidate: OSMCandidate) {
  return [
    `${candidate.placeName}`,
    `provider=${candidate.provider ?? "osm"}`,
    `category=${candidate.category}`,
    `id=${candidate.osmType}:${candidate.osmId}`,
    `lat=${candidate.latitude ?? "unknown"}`,
    `lon=${candidate.longitude ?? "unknown"}`,
    candidate.formattedAddress ? `address=${candidate.formattedAddress}` : "",
    candidate.providerCategories?.length
      ? `providerCategories=${candidate.providerCategories.join(" | ")}`
      : "",
    candidate.rating !== undefined ? `rating=${candidate.rating}` : "",
    candidate.reviewCount !== undefined ? `reviewCount=${candidate.reviewCount}` : "",
    candidate.reviewSummary ? `reviewSummary=${candidate.reviewSummary}` : "",
    `tags=${candidate.tags.join(" | ")}`,
    `activities=${candidate.possibleActivities.join(" | ")}`,
    `rawTags=${Object.entries(compactRawTags(candidate.rawTags))
      .map(([key, value]) => `${key}=${value}`)
      .join(" | ")}`,
  ]
    .filter(Boolean)
    .join(" ; ");
}

function logPage(page: PageContent) {
  return [
    `${page.sourceType}`,
    page.title ?? "untitled",
    page.url,
    page.score !== undefined ? `score=${page.score}` : "",
    `preview=${page.content.slice(0, 240).replace(/\s+/g, " ")}`,
  ]
    .filter(Boolean)
    .join(" ; ");
}

function logSocialCandidate(candidate: SocialCandidate) {
  return [
    `${candidate.activityName}`,
    candidate.placeName ? `place=${candidate.placeName}` : "",
    `sourceType=${candidate.sourceType}`,
    `sentiment=${candidate.sentiment}`,
    `confidence=${candidate.confidenceScore}`,
    `preference=${candidate.preferenceRelevanceScore}`,
    `tags=${candidate.tags.join(" | ")}`,
    `url=${candidate.sourceUrl}`,
    `evidence=${candidate.evidenceSummary}`,
  ]
    .filter(Boolean)
    .join(" ; ");
}

function logActivity(activity: ActivityDiscoveryItem) {
  return [
    `${activity.activityName}`,
    activity.placeName ? `place=${activity.placeName}` : "",
    `source=${activity.source}`,
    `fits=${activity.fitsPreference}`,
    `preference=${activity.preferenceMatchScore}`,
    `confidence=${activity.confidenceScore}`,
    activity.provider ? `provider=${activity.provider.name}:${activity.provider.id}` : "",
    activity.osm ? `osm=${activity.osm.type}:${activity.osm.id}` : "",
    `tags=${activity.tags.join(" | ")}`,
    `evidence=${activity.evidenceSummary}`,
    `reason=${activity.reason}`,
    activity.possibleConcerns.length
      ? `concerns=${activity.possibleConcerns.join(" | ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" ; ");
}

function buildCandidateCsv(candidates: OSMCandidate[]) {
  const headers = [
    "provider",
    "placeName",
    "category",
    "providerCategories",
    "osmType",
    "osmId",
    "latitude",
    "longitude",
    "formattedAddress",
    "distanceMeters",
    "estimatedCredits",
    "rating",
    "reviewCount",
    "reviewSummary",
    "sourceUrls",
    "tags",
    "possibleActivities",
    "rawTags",
  ];
  const rows = candidates.map((candidate) => [
    candidate.provider ?? "osm",
    candidate.placeName,
    candidate.category,
    (candidate.providerCategories ?? []).join(" | "),
    candidate.osmType,
    candidate.osmId,
    candidate.latitude ?? "",
    candidate.longitude ?? "",
    candidate.formattedAddress ?? "",
    candidate.distanceMeters ?? "",
    candidate.estimatedCredits ?? "",
    candidate.rating ?? "",
    candidate.reviewCount ?? "",
    candidate.reviewSummary ?? "",
    (candidate.sourceUrls ?? []).join(" | "),
    candidate.tags.join(" | "),
    candidate.possibleActivities.join(" | "),
    Object.entries(compactRawTags(candidate.rawTags))
      .map(([key, value]) => `${key}=${value}`)
      .join(" | "),
  ]);

  return rowsToCsv(headers, rows);
}

function buildPageCsv(pages: PageContent[]) {
  const headers = ["sourceType", "url", "title", "score", "contentPreview"];
  const rows = pages.map((page) => [
    page.sourceType,
    page.url,
    page.title ?? "",
    page.score ?? "",
    page.content.slice(0, 800),
  ]);

  return rowsToCsv(headers, rows);
}

function buildSocialCandidateCsv(candidates: SocialCandidate[]) {
  const headers = [
    "activityName",
    "placeName",
    "sourceType",
    "sourceUrl",
    "sentiment",
    "confidenceScore",
    "preferenceRelevanceScore",
    "tags",
    "evidenceSummary",
  ];
  const rows = candidates.map((candidate) => [
    candidate.activityName,
    candidate.placeName ?? "",
    candidate.sourceType,
    candidate.sourceUrl,
    candidate.sentiment,
    candidate.confidenceScore,
    candidate.preferenceRelevanceScore,
    candidate.tags.join(" | "),
    candidate.evidenceSummary,
  ]);

  return rowsToCsv(headers, rows);
}

function buildActivityCsv(activities: ActivityDiscoveryItem[]) {
  const headers = [
    "activityName",
    "placeName",
    "source",
    "fitsPreference",
    "preferenceMatchScore",
    "confidenceScore",
    "provider",
    "providerId",
    "providerCategories",
    "location",
    "tags",
    "sourceUrls",
    "verificationSources",
    "evidenceSummary",
    "reason",
    "missingInfo",
    "possibleConcerns",
  ];
  const rows = activities.map((activity) => [
    activity.activityName,
    activity.placeName ?? "",
    activity.source,
    activity.fitsPreference,
    activity.preferenceMatchScore,
    activity.confidenceScore,
    activity.provider?.name ?? (activity.osm ? "osm" : ""),
    activity.provider?.id ?? activity.osm?.id ?? "",
    activity.provider?.categories?.join(" | ") ?? activity.osm?.category ?? "",
    [
      activity.location?.label,
      activity.location?.latitude,
      activity.location?.longitude,
    ]
      .filter((value) => value !== undefined && value !== "")
      .join(" | "),
    activity.tags.join(" | "),
    activity.sourceUrls.join(" | "),
    (activity.verificationSources ?? []).join(" | "),
    activity.evidenceSummary,
    activity.reason,
    activity.missingInfo.join(" | "),
    activity.possibleConcerns.join(" | "),
  ]);

  return rowsToCsv(headers, rows);
}

function rowsToCsv(headers: string[], rows: unknown[][]) {
  return [headers, ...rows]
    .map((row) => row.map((value) => csvCell(String(value ?? ""))).join(","))
    .join("\n");
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function compactRawTags(tags: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(tags)
      .filter(([key]) => !["phone", "website", "source"].includes(key))
      .slice(0, 20),
  );
}

export class DiscoveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryConfigError";
  }
}
