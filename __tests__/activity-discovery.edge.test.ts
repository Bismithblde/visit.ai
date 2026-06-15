import { afterEach, describe, expect, test, vi } from "vitest";
import { collectDiscoveryContent } from "@/lib/activity-discovery/content-collector";
import { retrieveGooglePlacesCandidates } from "@/lib/activity-discovery/google-places";
import { fallbackIntentProfile, filterAndRankOsmCandidates } from "@/lib/activity-discovery/intent";
import { buildMergedActivities, finalRankAndDiversify } from "@/lib/activity-discovery/merge-rank";
import { OpenAIActivityClient } from "@/lib/activity-discovery/openai-activity";
import {
  retrieveOsmCandidates,
  retrieveTargetedOsmCandidates,
} from "@/lib/activity-discovery/osm";
import { resolveBusinessSearchArea } from "@/lib/activity-discovery/search-area";
import { parseDiscoveryRequest } from "@/lib/activity-discovery/validation";
import type {
  ActivityDiscoveryRequest,
  DiscoveryTool,
  IntentProfile,
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
        debugProviders: {
          tavily: false,
          googlePlaces: true,
          osm: false,
        },
      }),
    ).toEqual({
      ok: true,
      request: {
        cityOrLocation: "Queens",
        groupSize: 4,
        dateRange: { start: "2026-09-01", end: "2026-09-10" },
        preferencePrompt: "cheap outdoor",
        searchMode: "deep",
        debugProviders: {
          tavily: false,
          googlePlaces: true,
          osm: false,
        },
      },
    });
  });

  test("OpenAI query planning orchestrates food plus boba into separate Google Places subjects", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      const inputPayload = JSON.parse(String(body.input));

      expect(inputPayload.request.preferencePrompt).toBe("food + boba");
      expect(String(body.instructions)).toContain("boba + food");
      expect(String(body.instructions)).toContain("bubble tea");
      expect(body.text.format.schema.properties.queries).not.toHaveProperty("minItems");
      expect(body.text.format.schema.properties.queries).not.toHaveProperty("maxItems");

      return openAiJson({
        queries: [
          "best things to do in Flushing reddit",
          "food and boba Flushing reddit",
        ],
        relevantOsmCategories: ["restaurant", "cafe"],
        inferredTags: ["food", "bubble tea"],
        intentProfile: {
          primaryGoal: "food + boba",
          concepts: [
            { term: "food", weight: 0.75, type: "should" },
            { term: "boba", weight: 0.75, type: "should" },
          ],
          placeTypes: [],
          activityTypes: [],
          attributes: [],
          exclusions: [],
          reviewSearchTerms: ["food", "boba"],
          googlePlaceSubjects: ["bubble tea", "food"],
          googlePlaceQueries: ["bubble tea", "food"],
          minimumPreferenceScore: 0.32,
          searchAreaKind: "neighborhood",
          recommendedRadiusMeters: 5000,
          radiusReason: "Neighborhood food and beverage search.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAIActivityClient("openai-test-key", "gpt-4.1-mini");
    const plan = await client.generateQueryPlan({
      ...request,
      cityOrLocation: "Flushing, NY",
      preferencePrompt: "food + boba",
    });

    expect(plan.intentProfile.googlePlaceSubjects).toEqual(["bubble tea", "food"]);
    expect(plan.intentProfile.googlePlaceQueries).toEqual(["bubble tea", "food"]);
  });

  test("OpenAI query planning surfaces response body for bad request failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              message: "Invalid schema for response_format: unsupported keyword minItems.",
            },
          },
          400,
        ),
      ),
    );

    const client = new OpenAIActivityClient("openai-test-key", "gpt-4.1-mini");

    await expect(
      client.generateQueryPlan({
        ...request,
        cityOrLocation: "Flushing, NY",
        preferencePrompt: "food + boba",
      }),
    ).rejects.toThrow("unsupported keyword minItems");
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

  test("Google Places retrieval normalizes bubble tea and mixed bakery candidates", async () => {
    const textQueries: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("places.googleapis.com");

      if (url.pathname.startsWith("/v1/places/") && init?.method !== "POST") {
        const id = decodeURIComponent(url.pathname.replace("/v1/places/", ""));
        return jsonResponse(googlePlaceDetails(id));
      }

      const body = JSON.parse(String(init?.body));
      textQueries.push(body.textQuery);

      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "X-Goog-Api-Key": "google-places-test-key",
      });
      expect(body.textQuery).not.toContain("Queens");
      expect(body.locationBias).toMatchObject({
        circle: {
          center: { latitude: 40.7282, longitude: -73.7949 },
          radius: 5000,
        },
      });

      return jsonResponse({
        places: [
          {
            id: "bubble-1",
            displayName: { text: "Tiger Sugar" },
            formattedAddress: "Tiger Sugar, Flushing, NY",
            types: ["bubble_tea_store", "cafe", "food"],
            primaryType: "bubble_tea_store",
            location: { latitude: 40.75, longitude: -73.82 },
            rating: 4.6,
            userRatingCount: 300,
            googleMapsUri: "https://maps.google.com/?cid=bubble-1",
          },
          {
            id: "croffle-1",
            displayName: { text: "Croffle House" },
            formattedAddress: "Croffle House, Flushing, NY",
            types: ["bakery", "cafe", "food"],
            primaryType: "bakery",
            location: { latitude: 40.74, longitude: -73.81 },
            rating: 4.4,
            userRatingCount: 120,
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
    const intent = {
      ...fallbackIntentProfile(bubbleTeaRequest),
      googlePlaceSubjects: ["bubble tea", "croffle", "asian desserts"],
      googlePlaceQueries: ["bubble tea", "croffle", "asian desserts"],
    };
    const result = await retrieveGooglePlacesCandidates({
      apiKey: "google-places-test-key",
      request: bubbleTeaRequest,
      location,
      intent,
      searchArea: resolveBusinessSearchArea(
        location,
        intent,
        "balanced",
      ),
    });

    expect(result.debug).toMatchObject({
      calls: 5,
      estimatedCredits: 5,
      rawCandidates: 6,
      dedupedCandidates: 2,
    });
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "google_places",
          placeName: "Tiger Sugar",
          category: "google_places:bubble_tea_store",
          tags: expect.arrayContaining(["bubble tea", "food"]),
          rating: 4.6,
          reviewCount: 300,
          reviewSummary: expect.stringContaining("Great bubble tea"),
        }),
        expect.objectContaining({
          provider: "google_places",
          placeName: "Croffle House",
          tags: expect.arrayContaining(["bakery"]),
        }),
      ]),
    );
    expect(textQueries).toEqual(
      expect.arrayContaining([
        "bubble tea",
        "croffle",
        "asian desserts",
      ]),
    );
    expect(textQueries).toHaveLength(3);
  });

  test("Google Places query planning uses LLM-identified subjects only", async () => {
    const textQueries: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.startsWith("/v1/places/") && init?.method !== "POST") {
        const id = decodeURIComponent(url.pathname.replace("/v1/places/", ""));
        return jsonResponse(googlePlaceDetails(id));
      }

      const body = JSON.parse(String(init?.body));
      textQueries.push(body.textQuery);

      return jsonResponse({
        places: [
          {
            id: "bubble-1",
            displayName: { text: "Tiger Sugar" },
            formattedAddress: "Tiger Sugar, Flushing, NY",
            types: ["bubble_tea_store", "cafe", "food"],
            primaryType: "bubble_tea_store",
            location: { latitude: 40.75, longitude: -73.82 },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bubbleTeaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "I only want to drink bubble tea.",
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
    const intent = {
      ...fallbackIntentProfile(bubbleTeaRequest),
      googlePlaceSubjects: ["bubble tea"],
      googlePlaceQueries: ["bubble tea"],
    };
    const result = await retrieveGooglePlacesCandidates({
      apiKey: "google-places-test-key",
      request: bubbleTeaRequest,
      location,
      intent,
      searchArea: resolveBusinessSearchArea(
        location,
        intent,
        "balanced",
      ),
    });

    expect(result.debug.queries).toEqual(["bubble tea"]);
    expect(textQueries).toEqual(["bubble tea"]);
    expect(result.debug.calls).toBe(2);
  });

  test("Google Places runs multiple LLM-orchestrated bubble tea queries", async () => {
    const textQueries: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.startsWith("/v1/places/") && init?.method !== "POST") {
        return jsonResponse(googlePlaceDetails("bubble-1"));
      }

      const body = JSON.parse(String(init?.body));
      textQueries.push(body.textQuery);

      return jsonResponse({
        places: [
          {
            id: `place-${textQueries.length}`,
            displayName: { text: `Bubble Tea ${textQueries.length}` },
            formattedAddress: "Flushing, NY",
            types: ["bubble_tea_store", "food"],
            primaryType: "bubble_tea_store",
            location: {
              latitude: 40.75 + textQueries.length / 1000,
              longitude: -73.82,
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bubbleTeaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "only bubble tea.",
      searchMode: "balanced",
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

    const intent = {
      ...fallbackIntentProfile(bubbleTeaRequest),
      googlePlaceSubjects: [
        "bubble tea",
        "boba tea",
        "boba shop",
        "milk tea",
        "bubble tea cafe",
        "tea shop",
      ],
      googlePlaceQueries: [
        "bubble tea",
        "boba tea",
        "boba shop",
        "milk tea",
        "bubble tea cafe",
        "tea shop",
      ],
    };
    const result = await retrieveGooglePlacesCandidates({
      apiKey: "google-places-test-key",
      request: bubbleTeaRequest,
      location,
      intent,
      searchArea: resolveBusinessSearchArea(
        location,
        intent,
        "balanced",
      ),
    });

    expect(result.debug.queries).toEqual([
      "bubble tea",
      "boba tea",
      "boba shop",
      "milk tea",
      "bubble tea cafe",
      "tea shop",
    ]);
    expect(textQueries).toEqual(result.debug.queries);
    expect(result.debug.rawCandidates).toBe(6);
  });

  test("Google Places sends separate LLM-orchestrated queries for each subject", async () => {
    const textQueries: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.startsWith("/v1/places/") && init?.method !== "POST") {
        return jsonResponse(googlePlaceDetails("bubble-1"));
      }

      const body = JSON.parse(String(init?.body));
      textQueries.push(body.textQuery);

      return jsonResponse({
        places: [
          {
            id: "food-boba-1",
            displayName: { text: "Food Court Boba" },
            formattedAddress: "Flushing, NY",
            types: ["restaurant", "bubble_tea_store", "food"],
            primaryType: "restaurant",
            location: { latitude: 40.75, longitude: -73.82 },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const foodBobaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "food + boba",
      searchMode: "balanced",
    };
    const intent = {
      ...fallbackIntentProfile(foodBobaRequest),
      googlePlaceSubjects: ["food", "boba"],
      googlePlaceQueries: ["food + boba"],
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

    const result = await retrieveGooglePlacesCandidates({
      apiKey: "google-places-test-key",
      request: foodBobaRequest,
      location,
      intent,
      searchArea: resolveBusinessSearchArea(location, intent, "balanced"),
    });

    expect(result.debug.queries.slice(0, 2)).toEqual(["food", "boba"]);
    expect(result.debug.identifiedSubjects).toEqual(["food", "boba"]);
    expect(result.debug.rejectedCombinedQueries).toEqual(["food + boba"]);
    expect(textQueries.slice(0, 2)).toEqual(["food", "boba"]);
    expect(textQueries).not.toContain("food + boba");
  });

  test("Google Places skips when LLM subjects are absent instead of using heuristic fallback", async () => {
    const textQueries: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.startsWith("/v1/places/") && init?.method !== "POST") {
        return jsonResponse(googlePlaceDetails("bubble-1"));
      }

      const body = JSON.parse(String(init?.body));
      textQueries.push(body.textQuery);

      return jsonResponse({
        places: [
          {
            id: `fallback-${textQueries.length}`,
            displayName: { text: `Fallback ${textQueries.length}` },
            formattedAddress: "Flushing, NY",
            types: ["food"],
            primaryType: "restaurant",
            location: { latitude: 40.75, longitude: -73.82 },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const foodBobaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "boba + food",
      searchMode: "balanced",
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

    const result = await retrieveGooglePlacesCandidates({
      apiKey: "google-places-test-key",
      request: foodBobaRequest,
      location,
      intent: fallbackIntentProfile(foodBobaRequest),
      searchArea: resolveBusinessSearchArea(
        location,
        fallbackIntentProfile(foodBobaRequest),
        "balanced",
      ),
    });

    expect(result.debug).toMatchObject({
      status: "skipped",
      skipReason: "no Google Places subjects or queries returned by LLM",
      identifiedSubjects: [],
      queries: [],
    });
    expect(textQueries).toEqual([]);
  });

  test("Google Places reports a missing API key as an explicit skip reason", async () => {
    const bubbleTeaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "bubble tea",
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

    const result = await retrieveGooglePlacesCandidates({
      apiKey: undefined,
      request: bubbleTeaRequest,
      location,
      intent: fallbackIntentProfile(bubbleTeaRequest),
      searchArea: resolveBusinessSearchArea(
        location,
        fallbackIntentProfile(bubbleTeaRequest),
        "balanced",
      ),
    });

    expect(result.candidates).toEqual([]);
    expect(result.debug).toMatchObject({
      status: "skipped",
      skipReason: "missing GOOGLE_PLACES_API_KEY",
      calls: 0,
      errors: [],
    });
  });

  test("Google Places tolerates non-string intent terms from model output", async () => {
    const textQueries: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.startsWith("/v1/places/") && init?.method !== "POST") {
        return jsonResponse(googlePlaceDetails("bubble-1"));
      }

      const body = JSON.parse(String(init?.body));
      textQueries.push(body.textQuery);

      return jsonResponse({
        places: [
          {
            id: "bubble-1",
            displayName: { text: "Tiger Sugar" },
            formattedAddress: "Tiger Sugar, Flushing, NY",
            types: ["bubble_tea_store", "food"],
            primaryType: "bubble_tea_store",
            location: { latitude: 40.75, longitude: -73.82 },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bubbleTeaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "I only want to drink bubble tea.",
      searchMode: "fast",
    };
    const fallback = fallbackIntentProfile(bubbleTeaRequest);
    const malformedIntent = {
      ...fallback,
      concepts: [
        { term: { text: "bubble tea" }, weight: 0.8, type: "should" },
      ],
      reviewSearchTerms: [{ text: "bubble tea" }],
      googlePlaceSubjects: ["bubble tea"],
      googlePlaceQueries: ["bubble tea"],
    } as unknown as IntentProfile;
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

    const result = await retrieveGooglePlacesCandidates({
      apiKey: "google-places-test-key",
      request: bubbleTeaRequest,
      location,
      intent: malformedIntent,
      searchArea: resolveBusinessSearchArea(location, malformedIntent, "balanced"),
    });

    expect(result.debug.status).toBe("completed");
    expect(result.debug.errors).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(textQueries).toEqual(["bubble tea"]);
  });

  test("Google Places records provider errors instead of looking like empty results", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            message: "Invalid field mask.",
          },
        },
        400,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const bubbleTeaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "bubble tea",
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
    const intent = {
      ...fallbackIntentProfile(bubbleTeaRequest),
      googlePlaceSubjects: ["bubble tea"],
      googlePlaceQueries: ["bubble tea"],
    };
    const result = await retrieveGooglePlacesCandidates({
      apiKey: "google-places-test-key",
      request: bubbleTeaRequest,
      location,
      intent,
      searchArea: resolveBusinessSearchArea(
        location,
        intent,
        "balanced",
      ),
    });

    expect(result.candidates).toEqual([]);
    expect(result.debug.status).toBe("failed");
    expect(result.debug.errors[0]).toContain("Google Places Text Search failed");
    expect(result.debug.errors[0]).toContain("Invalid field mask");
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

  test("Google Places direct matches rank above weak OSM-only candidates", () => {
    const bubbleTeaRequest: ActivityDiscoveryRequest = {
      ...request,
      preferencePrompt: "bubble tea with friends",
    };
    const merged = buildMergedActivities({
      request: bubbleTeaRequest,
      osmCandidates: [
        osmCandidate({
          provider: "google_places",
          osmId: "google-1",
          osmType: "google_places",
          placeName: "Gong Cha",
          category: "google_places:bubble_tea_store",
          providerCategories: ["bubble_tea_store"],
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
      source: "google_places",
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

function openAiJson(body: unknown) {
  return jsonResponse({
    output: [
      {
        content: [{ type: "output_text", text: JSON.stringify(body) }],
      },
    ],
  });
}

function googlePlaceDetails(id: string) {
  if (id === "croffle-1") {
    return {
      id,
      displayName: { text: "Croffle House" },
      formattedAddress: "Croffle House, Flushing, NY",
      types: ["bakery", "cafe", "food"],
      primaryType: "bakery",
      location: { latitude: 40.74, longitude: -73.81 },
      rating: 4.4,
      userRatingCount: 120,
      googleMapsUri: "https://maps.google.com/?cid=croffle-1",
      reviews: [
        {
          rating: 4,
          relativePublishTimeDescription: "2 weeks ago",
          text: { text: "Fresh croffles and pastries." },
          authorAttribution: { displayName: "Lee" },
        },
      ],
    };
  }

  return {
    id,
    displayName: { text: "Tiger Sugar" },
    formattedAddress: "Tiger Sugar, Flushing, NY",
    types: ["bubble_tea_store", "cafe", "food"],
    primaryType: "bubble_tea_store",
    location: { latitude: 40.75, longitude: -73.82 },
    rating: 4.6,
    userRatingCount: 300,
    googleMapsUri: "https://maps.google.com/?cid=bubble-1",
    editorialSummary: { text: "Known for brown sugar bubble tea." },
    reviews: [
      {
        rating: 5,
        relativePublishTimeDescription: "a month ago",
        text: { text: "Great bubble tea and fast service." },
        authorAttribution: { displayName: "Sam" },
      },
    ],
  };
}
