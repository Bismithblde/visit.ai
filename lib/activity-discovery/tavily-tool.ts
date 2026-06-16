import { getSourceType } from "./source-quality";
import type {
  DiscoveryTool,
  DiscoveryToolDebug,
  PageContent,
  SearchResult,
} from "./types";

const TAVILY_BASE_URL = "https://api.tavily.com";

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    raw_content?: string | null;
    score?: number;
  }>;
  usage?: { credits?: number };
  request_id?: string;
}

interface TavilyExtractResponse {
  results?: Array<{
    url?: string;
    raw_content?: string;
    content?: string;
    title?: string;
  }>;
  failed_results?: Array<{ url?: string; error?: string }>;
  usage?: { credits?: number };
  request_id?: string;
}

interface TavilyCrawlResponse {
  results?: Array<{
    url?: string;
    raw_content?: string;
    content?: string;
    title?: string;
  }>;
  usage?: { credits?: number };
  request_id?: string;
}

export class TavilyDiscoveryTool implements DiscoveryTool {
  readonly debug: DiscoveryToolDebug = {
    visitedUrls: [],
    failedUrls: [],
    requestIds: [],
    credits: 0,
    errors: [],
  };

  constructor(private readonly apiKey: string) {}

  async web_search(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await this.post<TavilySearchResponse>("/search", {
      query,
      max_results: Math.min(Math.max(maxResults, 1), 20),
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_favicon: false,
      include_usage: true,
    });

    return (response.results ?? [])
      .filter((result) => result.url)
      .map((result) => ({
        title: result.title ?? "",
        url: result.url ?? "",
        content: result.content ?? result.raw_content ?? "",
        score: typeof result.score === "number" ? result.score : 0,
      }));
  }

  async extract_page(url: string): Promise<PageContent> {
    this.debug.visitedUrls.push(url);

    const response = await this.post<TavilyExtractResponse>("/extract", {
      urls: url,
      extract_depth: "basic",
      include_images: false,
      include_favicon: false,
      format: "markdown",
      timeout: 12,
      include_usage: true,
    });

    const result = response.results?.[0];
    const content = result?.raw_content ?? result?.content ?? "";

    if (!content.trim()) {
      this.debug.failedUrls.push(url);
      const failedReason = response.failed_results
        ?.map((failed) => failed.error)
        .filter(Boolean)
        .join("; ");
      throw new Error(
        `Tavily extract returned no content for ${url}${failedReason ? `: ${failedReason}` : ""}`,
      );
    }

    return {
      url: result?.url ?? url,
      title: result?.title,
      content,
      sourceType: getSourceType(result?.url ?? url),
    };
  }

  async crawl_page(url: string, maxDepth: number): Promise<PageContent[]> {
    this.debug.visitedUrls.push(url);

    const response = await this.post<TavilyCrawlResponse>("/crawl", {
      url,
      max_depth: Math.min(Math.max(maxDepth, 1), 5),
      max_breadth: 10,
      limit: 10,
      allow_external: false,
      extract_depth: "basic",
      include_images: false,
      include_favicon: false,
      format: "markdown",
      timeout: 30,
      include_usage: true,
    });

    const pages = (response.results ?? [])
      .filter((result) => result.url && (result.raw_content ?? result.content))
      .map((result) => ({
        url: result.url ?? url,
        title: result.title,
        content: result.raw_content ?? result.content ?? "",
        sourceType: getSourceType(result.url ?? url),
      }));

    if (pages.length === 0) {
      this.debug.failedUrls.push(url);
    }

    return pages;
  }

  private async post<T extends { request_id?: string; usage?: { credits?: number } }>(
    path: string,
    body: Record<string, unknown>,
  ) {
    const response = await fetch(`${TAVILY_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const compactBody = errorBody.replace(/\s+/g, " ").trim().slice(0, 500);
      const message = `Tavily ${path} failed with ${response.status} ${response.statusText}${compactBody ? `: ${compactBody}` : ""}`;
      this.debug.errors?.push(message);
      throw new Error(
        message,
      );
    }

    const data = (await response.json()) as T;
    if (data.request_id) {
      this.debug.requestIds?.push(data.request_id);
    }
    if (typeof data.usage?.credits === "number") {
      this.debug.credits = (this.debug.credits ?? 0) + data.usage.credits;
    }
    return data;
  }
}
