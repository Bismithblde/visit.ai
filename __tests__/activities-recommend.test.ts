import { describe, expect, test, vi } from "vitest";
import { POST } from "@/app/api/activities/recommend/route";
import { normalizeLocation } from "@/lib/activities/location";
import { buildRequestCacheKey } from "@/lib/activities/normalize";
import { parsePreferences, parseRecommendationInput } from "@/lib/activities/preferences";
import { cleanPageToChunks, normalizeUrl } from "@/lib/activity-recommendation/content";
import {
  recommendActivities,
  type RecommendationResponse,
} from "@/lib/activity-recommendation/recommend";

describe("POST /api/activities/recommend", () => {
  test("returns 400 for malformed JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/activities/recommend", {
        method: "POST",
        body: "{bad json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Request body must be valid JSON.",
    });
  });

  test("normalizes the new recommendation payload into the existing activity request shape", () => {
    const parsed = parseRecommendationInput({
      location: " Flushing ",
      groupSize: 4,
      dateRange: { start: "2026-06-13", end: "2026-06-13" },
      budget: "$$",
      preferencePrompt: "Food-focused activities only",
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.activityRequest).toMatchObject({
        city: "Flushing",
        groupSize: 4,
        budget: "medium",
        preferences: "Food-focused activities only",
        dates: ["2026-06-13", "2026-06-13"],
      });
      expect(buildRequestCacheKey(parsed.activityRequest, parsePreferences(parsed.activityRequest))).toContain(
        "activity:v1:request:",
      );
    }
  });

  test("returns a cached recommendation response without populating inventory", async () => {
    const cached: RecommendationResponse = {
      activities: [
        {
          id: "cached-1",
          name: "Cached Food Hall",
          description: "Source-backed cached recommendation.",
          tags: ["food"],
          sourceConfidence: 0.9,
          sourceUrls: ["https://example.com/food"],
          evidence: [
            {
              url: "https://example.com/food",
              sourceType: "local_blog",
              snippet: "Evidence for the food hall.",
            },
          ],
          recommendationReason: "Matches your food preference",
          score: 0.91,
        },
      ],
      source: "web",
      debug: {
        requestHash: "hash",
        locationKey: "flushing-queens-ny",
        searchedQueries: [],
        fetchedUrls: [],
        cacheHits: {
          recommendation: false,
          locationInventory: false,
          pages: 0,
          extractions: 0,
        },
      },
    };
    const result = await recommendActivities(
      {
        location: "Flushing",
        groupSize: 4,
        preferencePrompt: "Food-focused activities only",
      },
      { cache: memoryCache() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.source).toBe("cache");
      expect(result.response.activities[0].name).toBe("Cached Food Hall");
    }

    function memoryCache() {
      return {
        async get<T>(key: string) {
          return key.startsWith("recommendation:") ? (cached as T) : null;
        },
        async set() {
          return;
        },
        async del() {
          return;
        },
        async setIfNotExists() {
          return false;
        },
      };
    }
  });
});

describe("activity recommendation helpers", () => {
  test("normalizes aliases and URL tracking parameters", () => {
    expect(normalizeLocation("Flushing")).toMatchObject({
      canonicalName: "Flushing, Queens, NY",
      normalizedKey: "flushing-queens-ny",
    });
    expect(normalizeUrl("https://www.example.com/path/?utm_source=x&b=2&a=1#top")).toBe(
      "https://example.com/path/?a=1&b=2",
    );
  });

  test("cleans HTML into useful source chunks", () => {
    const chunks = cleanPageToChunks({
      url: "https://example.com/flushing-food",
      title: "Best Things To Do In Flushing",
      html: `
        <html>
          <body>
            <nav>Subscribe Follow Us</nav>
            <main>
              <h2>New World Mall Food Court</h2>
              <p>Large indoor food hall in Flushing, Queens with many restaurant vendors and group-friendly tables near Main Street.</p>
              <p>Visitors can try dumplings, noodles, desserts, and other food activities in one indoor location.</p>
            </main>
          </body>
        </html>
      `,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("New World Mall Food Court");
    expect(chunks[0].text).toContain("Flushing, Queens");
  });
});
