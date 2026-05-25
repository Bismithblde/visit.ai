import { describe, expect, test } from "vitest";
import { collectDiscoveryContent } from "@/lib/activity-discovery/content-collector";
import { buildQueryPlan } from "@/lib/activity-discovery/query-plan";
import { postprocessDiscovery } from "@/lib/activity-discovery/postprocess";
import { parseDiscoveryRequest } from "@/lib/activity-discovery/validation";
import type {
  ActivityCandidate,
  ActivityCluster,
  ActivityDiscoveryRequest,
  DiscoveryTool,
} from "@/lib/activity-discovery/types";

const request: ActivityDiscoveryRequest = {
  location: "Queens",
  groupSize: 4,
  budget: "low",
  preferences: ["arcade", "hidden", "arcade", "late night", "music"],
  searchMode: "balanced",
};

describe("activity discovery edge cases", () => {
  test("normalizes request input and rejects invalid boundaries", () => {
    expect(parseDiscoveryRequest(null)).toEqual({
      ok: false,
      error: "Request body must be a JSON object.",
    });

    expect(
      parseDiscoveryRequest({
        location: "   ",
        groupSize: 2,
      }),
    ).toEqual({ ok: false, error: "location is required." });

    expect(
      parseDiscoveryRequest({
        location: "NYC",
        groupSize: "51",
      }),
    ).toEqual({
      ok: false,
      error: "groupSize must be an integer between 1 and 50.",
    });

    expect(
      parseDiscoveryRequest({
        location: " Queens ",
        groupSize: "4",
        budget: "LOW",
        preferences: "arcade, karaoke, , cheap",
        searchMode: "DEEP",
      }),
    ).toEqual({
      ok: true,
      request: {
        location: "Queens",
        groupSize: 4,
        budget: "low",
        preferences: ["arcade", "karaoke", "cheap"],
        searchMode: "deep",
      },
    });
  });

  test("builds required and preference-specific searches without duplicate strings", () => {
    const plan = buildQueryPlan(request);

    expect(plan).toContain("niche activities in Queens reddit");
    expect(plan).toContain("arcade karaoke bowling billiards activities in Queens");
    expect(plan).toContain("arcade activities in Queens");
    expect(plan).toContain("hidden activities in Queens");
    expect(new Set(plan).size).toBe(plan.length);
  });

  test("ranks, dedupes, truncates, and records failed content collection paths", async () => {
    const longContent = "local guide ".repeat(800);
    const tool: DiscoveryTool & { debug: { failedUrls: string[] } } = {
      debug: { failedUrls: ["https://example.com/debug-failure"] },
      async web_search() {
        return [
          {
            title: "Weak duplicate",
            url: "https://plain.example.com/activities",
            content: "fallback content from search result",
            score: 0.95,
          },
          {
            title: "Local guide",
            url: "https://www.timeout.com/newyork/things-to-do/hidden-fun",
            content: "local blog result",
            score: 0.4,
          },
          {
            title: "Plain higher duplicate",
            url: "https://plain.example.com/activities",
            content: "higher duplicate content",
            score: 0.99,
          },
        ];
      },
      async extract_page(url) {
        if (url.includes("plain.example.com")) {
          throw new Error("extract failed");
        }

        return {
          url,
          title: "Local guide",
          content: longContent,
          sourceType: "local_blog",
        };
      },
      async crawl_page() {
        return [];
      },
    };

    const result = await collectDiscoveryContent(request, ["query one"], tool);

    expect(result.debug.searchedQueries).toEqual(["query one"]);
    expect(result.debug.visitedUrls).toEqual([
      "https://www.timeout.com/newyork/things-to-do/hidden-fun",
      "https://plain.example.com/activities",
    ]);
    expect(result.debug.failedUrls).toEqual([
      "https://plain.example.com/activities",
      "https://example.com/debug-failure",
    ]);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].content).toHaveLength(3000);
    expect(result.pages[1]).toMatchObject({
      url: "https://plain.example.com/activities",
      title: "Plain higher duplicate",
      sourceType: "other",
    });
  });

  test("extracts ranked pages with a concurrency limit of four", async () => {
    let activeExtracts = 0;
    let maxActiveExtracts = 0;
    const completedUrls: string[] = [];
    const urls = Array.from(
      { length: 6 },
      (_, index) => `https://example.com/activity-${index + 1}`,
    );
    const tool: DiscoveryTool = {
      async web_search() {
        return urls.map((url, index) => ({
          title: `Activity ${index + 1}`,
          url,
          content: `Snippet ${index + 1}`,
          score: 1 - index * 0.01,
        }));
      },
      async extract_page(url) {
        activeExtracts += 1;
        maxActiveExtracts = Math.max(maxActiveExtracts, activeExtracts);

        await new Promise((resolve) => setTimeout(resolve, 5));

        activeExtracts -= 1;
        completedUrls.push(url);

        return {
          url,
          title: url,
          content: `Extracted content for ${url}`,
          sourceType: "other",
        };
      },
      async crawl_page() {
        return [];
      },
    };

    const result = await collectDiscoveryContent(request, ["query one"], tool);

    expect(result.pages.map((page) => page.url)).toEqual(urls);
    expect(completedUrls).toHaveLength(6);
    expect(maxActiveExtracts).toBe(4);
  });

  test("uses ranked search snippets after the full extraction budget", async () => {
    const urls = Array.from(
      { length: 10 },
      (_, index) => `https://example.com/ranked-${index + 1}`,
    );
    const extractedUrls: string[] = [];
    const tool: DiscoveryTool = {
      async web_search() {
        return urls.map((url, index) => ({
          title: `Ranked ${index + 1}`,
          url,
          content: `Search snippet ${index + 1}`,
          score: 1 - index * 0.01,
        }));
      },
      async extract_page(url) {
        extractedUrls.push(url);

        return {
          url,
          title: url,
          content: `Extracted page ${url}`,
          sourceType: "other",
        };
      },
      async crawl_page() {
        return [];
      },
    };

    const result = await collectDiscoveryContent(request, ["query one"], tool);

    expect(extractedUrls).toEqual(urls.slice(0, 8));
    expect(result.debug.visitedUrls).toEqual(urls.slice(0, 8));
    expect(result.pages.map((page) => page.url)).toEqual(urls);
    expect(result.pages[8]).toMatchObject({
      url: "https://example.com/ranked-9",
      title: "Ranked 9",
      content: "Ranked 9\n\nSearch snippet 9",
      sourceType: "other",
    });
  });

  test("postprocesses unsafe model output into bounded, scored candidates and clusters", () => {
    const candidates: ActivityCandidate[] = [
      candidate({
        name: "The Arcade Center",
        description: "Hidden local arcade with rhythm games.",
        sourceUrls: ["https://reddit.com/r/nyc/comments/abc", "not-a-url"],
        confidence: 9,
      }),
      candidate({
        name: "Arcade",
        description: "Short",
        evidenceSnippets: ["Second mention with better local detail."],
        sourceUrls: ["https://www.timeout.com/newyork/things-to-do/arcade"],
        confidence: 0.2,
      }),
      candidate({
        name: "No Evidence",
        sourceUrls: [],
        evidenceSnippets: [],
      }),
    ];
    const clusters: ActivityCluster[] = [
      {
        id: "",
        title: "Arcade night",
        theme: "games",
        description: "A compact cluster.",
        candidateNames: ["The Arcade Center", "Missing candidate"],
        tags: ["hidden", "hidden", ""],
        sourceUrls: ["https://reddit.com/r/nyc/comments/abc", "ftp://bad"],
        confidence: 2,
        needsVerification: true,
      },
    ];

    const result = postprocessDiscovery(request, candidates, clusters);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      name: "The Arcade Center",
      description: "Hidden local arcade with rhythm games.",
      sourceUrls: [
        "https://reddit.com/r/nyc/comments/abc",
        "https://www.timeout.com/newyork/things-to-do/arcade",
      ],
      needsVerification: true,
    });
    expect(result.candidates[0].confidence).toBeGreaterThan(0);
    expect(result.candidates[0].confidence).toBeLessThanOrEqual(1);
    expect(result.clusters).toEqual([
      {
        id: "arcade-night",
        title: "Arcade night",
        theme: "games",
        description: "A compact cluster.",
        candidateNames: ["The Arcade Center"],
        tags: ["hidden"],
        sourceUrls: ["https://reddit.com/r/nyc/comments/abc"],
        confidence: 1,
        needsVerification: true,
      },
    ]);
  });
});

function candidate(overrides: Partial<ActivityCandidate>): ActivityCandidate {
  return {
    name: "Sample",
    type: "place",
    description: "Sample description",
    locationHint: "Queens",
    budgetFit: "low",
    groupFit: "small_group",
    tags: ["arcade"],
    sourceUrls: ["https://example.com"],
    evidenceSnippets: ["Sample evidence"],
    confidence: 0.5,
    needsVerification: true,
    ...overrides,
  };
}
