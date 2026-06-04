import { afterEach, describe, expect, test, vi } from "vitest";
import { POST } from "@/app/api/activities/route";
import { discoverRankedActivities } from "@/lib/activities/discover";
import { buildRequestCacheKey } from "@/lib/activities/normalize";
import { parsePreferences } from "@/lib/activities/preferences";
import type { ActivityRecord } from "@/lib/activities/types";
import type { ActivityStore } from "@/lib/activities/store";

describe("POST /api/activities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("returns 400 for malformed JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/activities", {
        method: "POST",
        body: "{bad json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Request body must be valid JSON.",
    });
  });

  test("normalizes reordered request details into the same cache key", () => {
    const first = {
      city: " Boston ",
      preferences: "more food and local spots, avoid tourist traps",
      balancePreferences: ["hidden_gem", "food"],
      budget: "low" as const,
    };
    const second = {
      city: "boston",
      balancePreferences: ["food", "hidden_gem"],
      preferences: "more food and local spots, avoid tourist traps",
      budget: "low" as const,
    };

    const firstParsed = parsePreferences(first);
    const secondParsed = parsePreferences(second);
    expect(buildRequestCacheKey(first, firstParsed)).toBe(
      buildRequestCacheKey(second, secondParsed),
    );
  });

  test("returns ranked DB activities without Tavily when coverage is sufficient", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = fakeStore({
      activities: Array.from({ length: 12 }, (_, index) =>
        activityRecord({
          id: `db-${index}`,
          name: `Boston Food Spot ${index}`,
          tags: [
            { tag: "food", weight: 1, confidence: 0.9 },
            { tag: "local_favorite", weight: 1, confidence: 0.8 },
          ],
        }),
      ),
    });

    const result = await discoverRankedActivities(
      {
        city: "Boston",
        preferences: "more food and local spots",
        budget: "low",
      },
      { store, cache: memoryCache() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.source).toBe("database");
      expect(result.response.activities).toHaveLength(12);
      expect(result.response.debug.tavilyQueries).toEqual([]);
      expect(result.response.activities[0].recommendationReason).toContain("food");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses Tavily snippets when DB coverage is weak", async () => {
    process.env.TAVILY_API_KEY = "test-tavily-key";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.tavily.com/search");
      return jsonResponse({
        results: [
          {
            title: "Boston Hidden Food Market",
            url: "https://reddit.com/r/boston/comments/hidden_food",
            content: "Locals recommend a hidden affordable food market.",
            score: 0.9,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = fakeStore({ activities: [] });

    const result = await discoverRankedActivities(
      {
        city: "Boston",
        preferences: "food hidden gems cheap",
        budget: "low",
      },
      { store, cache: memoryCache() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.source).toBe("tavily");
      expect(result.response.activities[0]).toMatchObject({
        name: "Boston Hidden Food Market",
      });
      expect(result.response.debug.tavilyQueries.length).toBeGreaterThanOrEqual(3);
      expect(result.response.debug.tavilyQueries.length).toBeLessThanOrEqual(5);
    }
    expect(fetchMock).toHaveBeenCalledTimes(result.ok ? result.response.debug.tavilyQueries.length : 0);
    expect(store.upsertCandidates).toHaveBeenCalled();
  });
});

function activityRecord(overrides: Partial<ActivityRecord>): ActivityRecord {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "activity",
    name: "Activity",
    normalizedName: "activity",
    city: "boston",
    region: null,
    country: null,
    description: "A source-backed activity.",
    latitude: null,
    longitude: null,
    address: null,
    priceLevel: "cheap",
    confidenceScore: 0.8,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
    tags: [{ tag: "food", weight: 1, confidence: 0.8 }],
    sources: [
      {
        sourceType: "reddit",
        url: "https://reddit.com/r/boston/comments/activity",
        title: "Activity",
        snippet: "Local evidence.",
        queryUsed: "query",
        confidence: 0.9,
        createdAt: now,
      },
    ],
    ...overrides,
  };
}

function fakeStore({ activities }: { activities: ActivityRecord[] }) {
  return {
    findActivities: vi.fn(async () => activities),
    saveSearchResults: vi.fn(async () => undefined),
    upsertCandidates: vi.fn(async () => undefined),
    updateCityCoverage: vi.fn(async () => undefined),
  } satisfies ActivityStore;
}

function memoryCache() {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return (values.get(key) as T | undefined) ?? null;
    },
    async set<T>(key: string, value: T) {
      values.set(key, value);
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
