import { afterEach, describe, expect, test, vi } from "vitest";
import { collectDiscoveryContent } from "@/lib/activity-discovery/content-collector";
import { retrieveGeoapifyCandidates } from "@/lib/activity-discovery/geoapify";
import { fallbackIntentProfile, filterAndRankOsmCandidates } from "@/lib/activity-discovery/intent";
import { buildMergedActivities, finalRankAndDiversify } from "@/lib/activity-discovery/merge-rank";
import {
  retrieveOsmCandidates,
  retrieveTargetedOsmCandidates,
} from "@/lib/activity-discovery/osm";
import { resolveBusinessSearchArea } from "@/lib/activity-discovery/search-area";
import { parseDiscoveryRequest } from "@/lib/activity-discovery/validation";
import type {
  ActivityDiscoveryRequest,
  DiscoveryTool,
  OSMCandidate,
  SocialCandidate,
} from "@/lib/activity-discovery/types";

const request: ActivityDiscoveryRequest = {
  cityOrLocation: "Queens",
  groupSize: 4,
  dateRange: { start: "2026-07-01", end: "2026-07-03" },
  preferencePrompt: "cheap outdoor hidden gems with friends",
  searchMode: "balanced",
};

describe("activity discovery edge cases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("normalizes new request input and rejects invalid boundaries", () => {
    expect(parseDiscoveryRequest(null)).toEqual({
      ok: false,
      error: "Request body must be a JSON object.",
    });

    expect(
      parseDiscoveryRequest({
        cityOrLocation: "   ",
        groupSize: 2,
      }),
    ).toEqual({ ok: false, error: "cityOrLocation is required." });

    expect(
      parseDiscoveryRequest({
        cityOrLocation: "NYC",
        groupSize: "51",
      }),
    ).toEqual({
      ok: false,
      error: "groupSize must be an integer between 1 and 50.",
    });

    expect(
      parseDiscoveryRequest({
        cityOrLocation: "NYC",
        groupSize: "4",
        dateRange: { start: "2026-09-10", end: "2026-09-01" },
      }),
    ).toEqual({
      ok: false,
      error: "dateRange must use YYYY-MM-DD start/end values.",
    });

    expect(
      parseDiscoveryRequest({
        cityOrLocation: " Queens ",
        groupSize: "4",
        dateRange: { start: "2026-09-01", end: "2026-09-10" },
        preferencePrompt: "cheap outdoor",
        searchMode: "DEEP",
      }),
    ).toEqual({
      ok: true,
      request: {
        cityOrLocation: "Queens",
        groupSize: 4,
        dateRange: { start: "2026-09-01", end: "2026-09-10" },
        preferencePrompt: "cheap outdoor",
        searchMode: "deep",
      },
    });
  });

  test("normalizes OSM geocode and Overpass results into activity candidates", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("https://nominatim.openstreetmap.org/search")) {
        return jsonResponse([
          {
            lat: "40.7282",
            lon: "-73.7949",
            boundingbox: ["40.50", "40.90", "-74.05", "-73.70"],
          },
        ]);
      }

      if (url === "https://overpass-api.de/api/interpreter") {
        return jsonResponse({
          elements: [
            {
              id: 1,
              type: "node",
              lat: 40.7,
              lon: -73.8,
              tags: { name: "Flushing Meadows Corona Park", leisure: "park", fee: "no" },
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await retrieveOsmCandidates(request);

    expect(result.location).toMatchObject({
      query: "Queens",
      latitude: 40.7282,
      longitude: -73.7949,
      boundingBox: [40.5, 40.9, -74.05, -73.7],
    });
    expect(result.candidates[0]).toMatchObject({
      placeName: "Flushing Meadows Corona Park",
      category: "leisure:park",
      tags: expect.arrayContaining(["outdoor", "free"]),
      possibleActivities: expect.arrayContaining(["walk", "picnic"]),
    });
  });

  test("targeted OSM search finds intent-specific place names and cuisine tags", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://overpass-api.de/api/interpreter") {
        const body = decodeURIComponent(String(init?.body));
        expect(body).toContain("bubble");
        expect(body).toContain("cuisine");
        expect(body).toContain("(around:5000,40.7282,-73.7949)");
        return jsonResponse({
          elements: [
            {
              id: 20,
              type: "node",
              lat: 40.75,
              lon: -73.82,
              tags: {
                name: "Tiger Sugar",
                amenity: "cafe",
                cuisine: "bubble_tea",
              },
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const location = {
      query: "Queens",
      latitude: 40.7282,
      longitude: -73.7949,
      boundingBox: [40.5, 40.9, -74.05, -73.7] as [
        number,
        number,
        number,
        number,
      ],
    };
    const result = await retrieveTargetedOsmCandidates(
      location,
      ["bubble tea", "asian"],
      resolveBusinessSearchArea(
        location,
        fallbackIntentProfile({ ...request, preferencePrompt: "bubble tea" }),
        "balanced",
      ),
    );

    expect(result[0]).toMatchObject({
      placeName: "Tiger Sugar",
      category: "amenity:cafe",
      tags: expect.arrayContaining(["bubble tea", "cuisine:bubble tea"]),
    });
  });

  test("resolves local business search area from LLM radius and clamps outliers", () => {
    const location = {
      query: "Flushing Queens",
      latitude: 40.7654301,
      longitude: -73.8174291,
      boundingBox: [40.7554301, 40.7754301, -73.8274291, -73.8074291] as [
        number,
        number,
        number,
        number,
      ],
    };
    const baseIntent = fallbackIntentProfile({
      ...request,
      cityOrLocation: "Flushing Queens",
      preferencePrompt: "bubble tea and Asian bakeries",
    });

    expect(
      resolveBusinessSearchArea(
        location,
        {
          ...baseIntent,
          searchAreaKind: "neighborhood",
          recommendedRadiusMeters: 5000,
          radiusReason: "Flushing is a neighborhood-scale business search.",
        },
        "balanced",
      ),
    ).toMatchObject({
      mode: "circle",
      source: "llm-radius",
      centerLatitude: 40.7654301,
      centerLongitude: -73.8174291,
      radiusMeters: 5000,
      bboxWidthKm: expect.any(Number),
      bboxHeightKm: expect.any(Number),
    });

    expect(
      resolveBusinessSearchArea(
        location,
        {
          ...baseIntent,
          searchAreaKind: "neighborhood",
          recommendedRadiusMeters: 20000,
        },
        "balanced",
      ).radiusMeters,
    ).toBe(8000);
  });

  test("Geoapify retrieval normalizes bubble tea and mixed bakery candidates", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      expect(url.hostname).toBe("api.geoapify.com");
      expect(url.searchParams.get("apiKey")).toBe("geoapify-test-key");
      expect(url.searchParams.get("filter")).toContain("circle:-73.7949,40.7282,5000");

      return jsonResponse({
        features: [
          {
            geometry: { coordinates: [-73.82, 40.75] },
            properties: {
              place_id: "bubble-1",
              name: "Tiger Sugar",
              formatted: "Tiger Sugar, Flushing, NY",
              categories: ["catering.cafe.bubble_tea", "catering.cafe"],
              lat: 40.75,
              lon: -73.82,
              distance: 450,
            },
          },
          {
            geometry: { coordinates: [-73.81, 40.74] },
            properties: {
              place_id: "croffle-1",
              name: "Croffle House",
              formatted: "Croffle House, Flushing, NY",
              categories: ["commercial.food_and_drink.bakery", "catering.cafe"],
              lat: 40.74,
              lon: -73.81,
              distance: 800,
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bubbleTeaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "I want bubble tea and croffles with Asian desserts.",
      searchMode: "fast",
    };
    const location = {
      query: "Queens",
      latitude: 40.7282,
      longitude: -73.7949,
      boundingBox: [40.5, 40.9, -74.05, -73.7] as [
        number,
        number,
        number,
        number,
      ],
    };
    const result = await retrieveGeoapifyCandidates({
      apiKey: "geoapify-test-key",
      request: bubbleTeaRequest,
      location,
      intent: fallbackIntentProfile(bubbleTeaRequest),
      searchArea: resolveBusinessSearchArea(
        location,
        fallbackIntentProfile(bubbleTeaRequest),
        "balanced",
      ),
    });

    expect(result.debug).toMatchObject({
      calls: 3,
      estimatedCredits: 3,
      rawCandidates: 6,
      dedupedCandidates: 2,
    });
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "geoapify",
          placeName: "Tiger Sugar",
          category: "geoapify:catering.cafe.bubble_tea",
          tags: expect.arrayContaining(["bubble tea", "food"]),
        }),
        expect.objectContaining({
          provider: "geoapify",
          placeName: "Croffle House",
          tags: expect.arrayContaining(["bakery"]),
        }),
      ]),
    );
  });

  test("collects ranked pages with fallback snippets and records failed URLs", async () => {
    const tool: DiscoveryTool & { debug: { failedUrls: string[] } } = {
      debug: { failedUrls: ["https://example.com/debug-failure"] },
      async web_search() {
        return [
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
          content: "local guide ".repeat(800),
          sourceType: "local_blog",
        };
      },
      async crawl_page() {
        return [];
      },
    };

    const result = await collectDiscoveryContent(request, ["query one"], tool);

    expect(result.debug.searchedQueries).toEqual(["query one"]);
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

  test("merges OSM and social evidence, dedupes, and diversifies final ranking", () => {
    const osmCandidates: OSMCandidate[] = [
      osmCandidate({
        placeName: "Flushing Meadows Corona Park",
        category: "leisure:park",
        tags: ["outdoor", "free", "scenic"],
        possibleActivities: ["walk", "picnic"],
      }),
      osmCandidate({
        osmId: "2",
        placeName: "Queens Museum",
        category: "tourism:museum",
        tags: ["indoor", "cultural"],
        possibleActivities: ["visit attraction"],
      }),
    ];
    const socialCandidates: SocialCandidate[] = [
      {
        activityName: "Walk at Flushing Meadows Corona Park",
        placeName: "Flushing Meadows Corona Park",
        sourceUrl: "https://reddit.com/r/queens/comments/park",
        sourceType: "reddit",
        tags: ["outdoor", "free", "local favorite"],
        sentiment: "positive",
        evidenceSummary: "Locals recommend it for cheap group walks.",
        confidenceScore: 0.8,
        preferenceRelevanceScore: 0.9,
      },
    ];

    const merged = buildMergedActivities({ request, osmCandidates, socialCandidates });
    const ranked = finalRankAndDiversify(merged, request);

    expect(merged).toHaveLength(2);
    expect(ranked[0]).toMatchObject({
      placeName: "Flushing Meadows Corona Park",
      source: "osm+reddit",
      sourceUrls: ["https://reddit.com/r/queens/comments/park"],
      preferenceMatchScore: 0.9,
    });
  });

  test("intent filtering favors OSM raw tag matches over generic places", () => {
    const bubbleTeaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "I want to drink bubble tea and eat food from Asian culture.",
    };
    const intent = fallbackIntentProfile(bubbleTeaRequest);
    const filtered = filterAndRankOsmCandidates(
      [
        osmCandidate({
          osmId: "tea",
          placeName: "Happy Lemon",
          category: "amenity:cafe",
          tags: ["food", "indoor", "bubble tea", "asian"],
          rawTags: {
            name: "Happy Lemon",
            amenity: "cafe",
            cuisine: "bubble_tea",
          },
          possibleActivities: ["food stop"],
        }),
        osmCandidate({
          osmId: "park",
          placeName: "Generic Playground",
          category: "leisure:playground",
          tags: ["outdoor", "group-friendly"],
          rawTags: {
            name: "Generic Playground",
            leisure: "playground",
          },
          possibleActivities: ["outdoor hangout"],
        }),
      ],
      intent,
    );

    expect(filtered[0].placeName).toBe("Happy Lemon");
    expect(filtered.map((candidate) => candidate.placeName)).not.toContain(
      "Generic Playground",
    );
  });

  test("Geoapify direct matches rank above weak OSM-only candidates", () => {
    const bubbleTeaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "bubble tea with friends",
    };
    const merged = buildMergedActivities({
      request: bubbleTeaRequest,
      osmCandidates: [
        osmCandidate({
          provider: "geoapify",
          osmId: "geo-1",
          osmType: "geoapify",
          placeName: "Gong Cha",
          category: "geoapify:catering.cafe.bubble_tea",
          providerCategories: ["catering.cafe.bubble_tea"],
          tags: ["food", "bubble tea", "catering cafe bubble tea"],
          possibleActivities: ["bubble tea stop", "food stop"],
        }),
        osmCandidate({
          osmId: "park",
          placeName: "Generic Playground",
          category: "leisure:playground",
          tags: ["outdoor", "group-friendly"],
          possibleActivities: ["outdoor hangout"],
        }),
      ],
      socialCandidates: [],
    });

    expect(merged[0]).toMatchObject({
      placeName: "Gong Cha",
      source: "geoapify",
      fitsPreference: true,
    });
  });

  test("returns no fallback candidates when strict verification rejects weak OSM matches", () => {
    const merged = buildMergedActivities({
      request,
      osmCandidates: [
        osmCandidate({
          placeName: "Queens Botanical Garden",
          category: "leisure:garden",
          tags: ["outdoor", "scenic"],
          possibleActivities: ["walk", "photography"],
        }),
      ],
      socialCandidates: [],
    }).map((activity) => ({ ...activity, fitsPreference: false }));

    const ranked = finalRankAndDiversify(merged, request);

    expect(ranked).toHaveLength(0);
  });
});

function osmCandidate(overrides: Partial<OSMCandidate>): OSMCandidate {
  return {
    activityName: "walk",
    placeName: "Sample Park",
    osmId: "1",
    osmType: "node",
    latitude: 40.7,
    longitude: -73.8,
    rawTags: { name: "Sample Park", leisure: "park" },
    category: "leisure:park",
    tags: ["outdoor"],
    possibleActivities: ["walk"],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
