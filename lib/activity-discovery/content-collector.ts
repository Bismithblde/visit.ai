import { isRedditUrl, fetchRedditJson } from "./reddit";
import { getSourceType, sourceQualityScore } from "./source-quality";
import type {
  ActivityDiscoveryRequest,
  DiscoveryTool,
  PageContent,
  SearchResult,
} from "./types";

interface CollectionResult {
  pages: PageContent[];
  debug: CollectionDebug;
}

interface CollectionDebug {
  searchedQueries: string[];
  visitedUrls: string[];
  failedUrls: string[];
  tavily: {
    searchRequests: number;
    searchResults: number;
    rankedUrls: number;
    extractedPages: number;
    snippetPages: number;
    fallbackPages: number;
    failedExtracts: number;
    credits: number;
    requestIds: string[];
    resultUrls: string[];
    errors: string[];
  };
}

const EXTRACT_CONCURRENCY = 4;
const PAGE_CONTENT_CHAR_LIMIT = 3000;

export async function collectDiscoveryContent(
  request: ActivityDiscoveryRequest,
  queryPlan: string[],
  tool: DiscoveryTool,
): Promise<CollectionResult> {
  const maxResultsPerQuery = getMaxResultsPerQuery(request.searchMode);
  const maxFullExtractedPages = getMaxFullExtractedPages(request.searchMode);
  const maxEvidencePages = getMaxEvidencePages(request.searchMode);
  const searchedQueries: string[] = [];
  const failedUrls: string[] = [];
  const searchErrors: string[] = [];

  const searchSettled = await Promise.allSettled(
    queryPlan.map(async (query) => {
      searchedQueries.push(query);
      return tool.web_search(query, maxResultsPerQuery);
    }),
  );

  searchSettled.forEach((result, index) => {
    if (result.status === "rejected") {
      searchErrors.push(
        `${queryPlan[index] ?? "unknown query"}: ${errorMessage(result.reason)}`,
      );
    }
  });
  const searchResults = searchSettled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const bestSearchResultByUrl = bestResultMap(searchResults);
  const urls = rankSearchUrls(searchResults).slice(0, maxEvidencePages);
  const extractedUrls = urls.slice(0, maxFullExtractedPages);
  const snippetUrls = urls.slice(maxFullExtractedPages);
  const collected = await mapWithConcurrency(
    extractedUrls,
    EXTRACT_CONCURRENCY,
    async (url) => collectPage(url, tool, bestSearchResultByUrl),
  );
  const pages = collected.flatMap((result) => {
    if (result.page) {
      return [result.page];
    }

    return [];
  }).concat(buildSnippetPages(snippetUrls, bestSearchResultByUrl));

  failedUrls.push(...collected.flatMap((result) => result.failedUrl ?? []));

  return {
    pages,
    debug: {
      searchedQueries,
      visitedUrls: extractedUrls,
      failedUrls: uniqueStrings([
        ...failedUrls,
        ...getToolDebugArray(tool, "failedUrls"),
      ]),
      tavily: {
        searchRequests: searchedQueries.length,
        searchResults: searchResults.length,
        rankedUrls: urls.length,
        extractedPages: collected.filter((result) => result.page).length,
        snippetPages: snippetUrls.filter((url) =>
          Boolean(bestSearchResultByUrl.get(url)?.content),
        ).length,
        fallbackPages: collected.filter(
          (result) => result.page && result.failedUrl,
        ).length,
        failedExtracts: failedUrls.length,
        credits: getToolDebugNumber(tool, "credits"),
        requestIds: uniqueStrings(getToolDebugArray(tool, "requestIds")),
        resultUrls: urls,
        errors: uniqueStrings([
          ...searchErrors,
          ...getToolDebugArray(tool, "errors"),
        ]),
      },
    },
  };
}

function buildSnippetPages(
  urls: string[],
  bestSearchResultByUrl: Map<string, SearchResult>,
) {
  return urls.flatMap((url) => {
    const result = bestSearchResultByUrl.get(url);

    if (!result?.content) {
      return [];
    }

    return [
      limitPageContent({
        url,
        title: result.title,
        content: `${result.title}\n\n${result.content}`,
        sourceType: getSourceType(url),
      }),
    ];
  });
}

async function collectPage(
  url: string,
  tool: DiscoveryTool,
  bestSearchResultByUrl: Map<string, SearchResult>,
) {
  try {
    const page = isRedditUrl(url)
      ? await fetchRedditThenFallback(url, tool)
      : await tool.extract_page(url);

    return { page: limitPageContent(page) };
  } catch {
    const fallback = bestSearchResultByUrl.get(url);

    if (!fallback?.content) {
      return { failedUrl: url };
    }

    return {
      failedUrl: url,
      page: limitPageContent({
        url,
        title: fallback.title,
        content: `${fallback.title}\n\n${fallback.content}`,
        sourceType: "other",
      }),
    };
  }
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
) {
  const results: U[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
  await Promise.all(workers);

  return results;
}

function bestResultMap(results: SearchResult[]) {
  const byUrl = new Map<string, SearchResult>();

  for (const result of results) {
    const existing = byUrl.get(result.url);
    if (!existing || result.score > existing.score) {
      byUrl.set(result.url, result);
    }
  }

  return byUrl;
}

function rankSearchUrls(results: SearchResult[]) {
  const byUrl = bestResultMap(results);

  return [...byUrl.keys()].sort((a, b) => {
    const qualityDiff = sourceQualityScore(b) - sourceQualityScore(a);
    const scoreDiff = (byUrl.get(b)?.score ?? 0) - (byUrl.get(a)?.score ?? 0);
    return qualityDiff || scoreDiff;
  });
}

async function fetchRedditThenFallback(url: string, tool: DiscoveryTool) {
  try {
    return await fetchRedditJson(url);
  } catch {
    return tool.extract_page(url);
  }
}

function getMaxResultsPerQuery(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 4;
    case "deep":
      return 7;
    default:
      return 5;
  }
}

function getMaxFullExtractedPages(
  searchMode: ActivityDiscoveryRequest["searchMode"],
) {
  switch (searchMode) {
    case "fast":
      return 6;
    case "deep":
      return 12;
    default:
      return 8;
  }
}

function getMaxEvidencePages(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 8;
    case "deep":
      return 16;
    default:
      return 12;
  }
}

function limitPageContent(page: PageContent): PageContent {
  return {
    ...page,
    content: page.content.slice(0, PAGE_CONTENT_CHAR_LIMIT),
  };
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

function getToolDebugNumber(tool: DiscoveryTool, key: string) {
  const maybeDebug = tool as DiscoveryTool & {
    debug?: Record<string, unknown>;
  };
  const value = maybeDebug.debug?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
