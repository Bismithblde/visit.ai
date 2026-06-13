import { getSourceType } from "./source-quality";
import { intentTerms } from "./intent";
import type {
  ActivityDiscoveryRequest,
  DiscoveryTool,
  IntentProfile,
  OSMCandidate,
  PageContent,
  SearchResult,
  SocialCandidate,
} from "./types";
import type { OpenAIActivityClient } from "./openai-activity";

interface ReviewVerificationResult {
  candidates: SocialCandidate[];
  reviewQueries: string[];
  visitedUrls: string[];
  failedUrls: string[];
}

const MAX_RESULTS_PER_REVIEW_QUERY = 3;
const MAX_REVIEW_PAGES = 24;

export async function verifyOsmCandidatesWithReviews({
  openAi,
  request,
  tool,
  intent,
  candidates,
}: {
  openAi: OpenAIActivityClient;
  request: ActivityDiscoveryRequest;
  tool: DiscoveryTool;
  intent: IntentProfile;
  candidates: OSMCandidate[];
}): Promise<ReviewVerificationResult> {
  if (candidates.length === 0) {
    return {
      candidates: [],
      reviewQueries: [],
      visitedUrls: [],
      failedUrls: [],
    };
  }

  const reviewQueries = buildReviewQueries(request, intent, candidates);
  const settled = await Promise.allSettled(
    reviewQueries.map((query) => tool.web_search(query, MAX_RESULTS_PER_REVIEW_QUERY)),
  );
  const searchResults = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const pages = buildReviewPages(searchResults).slice(0, MAX_REVIEW_PAGES);
  const extracted = await openAi.extractSocialCandidates(request, pages);

  return {
    candidates: extracted,
    reviewQueries,
    visitedUrls: pages.map((page) => page.url),
    failedUrls: getToolDebugArray(tool, "failedUrls"),
  };
}

function buildReviewQueries(
  request: ActivityDiscoveryRequest,
  intent: IntentProfile,
  candidates: OSMCandidate[],
) {
  const conceptText = intentTerms(intent).slice(0, 4).join(" ") || "reviews";
  const city = request.cityOrLocation;
  const queries: string[] = [];

  for (const candidate of candidates) {
    queries.push(`"${candidate.placeName}" "${city}" reviews ${conceptText}`);
    queries.push(`"${candidate.placeName}" "${city}" reddit`);
  }

  return uniqueStrings(queries).slice(0, reviewQueryLimit(request.searchMode));
}

function buildReviewPages(results: SearchResult[]): PageContent[] {
  const byUrl = new Map<string, SearchResult>();

  for (const result of results) {
    if (!isHttpUrl(result.url)) {
      continue;
    }

    const existing = byUrl.get(result.url);
    if (!existing || result.score > existing.score) {
      byUrl.set(result.url, result);
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .map((result) => ({
      url: result.url,
      title: result.title,
      sourceType: getSourceType(result.url),
      content: `${result.title}\n\n${result.content}`.slice(0, 1800),
      score: result.score,
    }));
}

function reviewQueryLimit(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 8;
    case "deep":
      return 24;
    default:
      return 16;
  }
}

function getToolDebugArray(tool: DiscoveryTool, key: string) {
  const maybeDebug = tool as DiscoveryTool & {
    debug?: Record<string, unknown>;
  };
  const value = maybeDebug.debug?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
