import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST } from "@/app/api/activities/discover/route";

const originalEnv = {
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_ACTIVITY_MODEL: process.env.OPENAI_ACTIVITY_MODEL,
};

describe("POST /api/activities/discover", () => {
  beforeEach(() => {
    process.env.TAVILY_API_KEY = "tavily-test-key";
    process.env.OPENAI_API_KEY = "openai-test-key";
    process.env.OPENAI_ACTIVITY_MODEL = "gpt-5.5-mini";
  });

  afterEach(() => {
    process.env.TAVILY_API_KEY = originalEnv.TAVILY_API_KEY;
    process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
    process.env.OPENAI_ACTIVITY_MODEL = originalEnv.OPENAI_ACTIVITY_MODEL;
    vi.unstubAllGlobals();
  });

  test("returns 400 for malformed JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/activities/discover", {
        method: "POST",
        body: "{bad json",
      }),
    );

    await expectJson(response, 400, {
      error: "Request body must be valid JSON.",
    });
  });

  test("returns 400 for invalid discovery input", async () => {
    const response = await POST(jsonRequest({ cityOrLocation: "", groupSize: 2 }));

    await expectJson(response, 400, { error: "cityOrLocation is required." });
  });

  test("returns 500 when required server env is missing", async () => {
    delete process.env.TAVILY_API_KEY;

    const response = await POST(
      jsonRequest({ cityOrLocation: "Queens", groupSize: 4 }),
    );

    await expectJson(response, 500, { error: "Missing TAVILY_API_KEY" });
  });

  test("returns 500 when OpenAI env is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    const response = await POST(
      jsonRequest({ cityOrLocation: "Queens", groupSize: 4 }),
    );

    await expectJson(response, 500, { error: "Missing OPENAI_API_KEY" });
  });

  test("runs the OSM, Tavily, and OpenAI discovery flow", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        expect(init?.method).toBe("POST");
        return jsonResponse({
          elements: [
            {
              id: 10,
              type: "node",
              lat: 40.7397,
              lon: -73.8408,
              tags: {
                name: "Flushing Meadows Corona Park",
                leisure: "park",
                fee: "no",
              },
            },
          ],
        });
      }

      if (url === "https://api.openai.com/v1/responses") {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer openai-test-key",
          "Content-Type": "application/json",
        });
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("gpt-5.5-mini");
        const instructions = String(body.instructions);

        if (instructions.includes("Generate concise Tavily search queries")) {
          return openAiJson({
            queries: [
              "best things to do in Queens reddit",
              "Queens hidden gems reddit",
              "cheap outdoor activities Queens reddit",
              "Queens parks waterfront walks reddit",
              "cheap outdoor activities Queens blog",
            ],
            relevantOsmCategories: ["park", "outdoor", "free"],
            inferredTags: ["cheap", "outdoor", "group-friendly"],
          });
        }

        if (instructions.includes("Extract activities")) {
          return openAiJson({
            candidates: [
              {
                activityName: "Outdoor Hangout at Flushing Meadows Corona Park",
                placeName: "Flushing Meadows Corona Park",
                sourceUrl: "https://reddit.com/r/queens/comments/park",
                sourceType: "reddit",
                tags: ["free", "outdoor", "local favorite", "group-friendly"],
                sentiment: "positive",
                evidenceSummary: "Reddit commenters recommend the park for cheap group walks.",
                confidenceScore: 0.82,
                preferenceRelevanceScore: 0.93,
              },
            ],
          });
        }

        if (instructions.includes("Verify and rerank")) {
          return openAiJson({
            activities: [
              {
                activityName: "Outdoor Hangout at Flushing Meadows Corona Park",
                placeName: "Flushing Meadows Corona Park",
                source: "osm+reddit",
                sourceUrls: ["https://reddit.com/r/queens/comments/park"],
                tags: ["free", "outdoor", "local favorite", "group-friendly"],
                confidenceScore: 0.92,
                preferenceMatchScore: 0.95,
                evidenceSummary:
                  "OSM confirms the park and Reddit supports it as a cheap outdoor group option.",
                reason:
                  "It directly matches cheap, outdoor, and friend-group preferences.",
                fitsPreference: true,
                missingInfo: ["Hours and weather should be checked."],
                possibleConcerns: ["Weather dependent."],
              },
            ],
          });
        }

        throw new Error(`Unexpected OpenAI instructions: ${instructions}`);
      }

      if (url === "https://api.tavily.com/search") {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer tavily-test-key",
          "Content-Type": "application/json",
        });

        return jsonResponse({
          results: [
            {
              title: "Queens park thread",
              url: "https://reddit.com/r/queens/comments/park",
              content: "Locals recommend cheap walks in Flushing Meadows.",
              score: 0.9,
            },
          ],
        });
      }

      if (url === "https://reddit.com/r/queens/comments/park.json") {
        return jsonResponse([
          {
            data: {
              children: [
                {
                  data: {
                    title: "Cheap outdoor Queens ideas",
                    selftext: "Where should four friends go?",
                  },
                },
              ],
            },
          },
          {
            data: {
              children: [
                {
                  data: {
                    body: "Flushing Meadows is a good free walk and easy for groups.",
                    score: 12,
                  },
                },
              ],
            },
          },
        ]);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      jsonRequest({
        cityOrLocation: "Queens",
        groupSize: 4,
        dateRange: { start: "2026-07-01", end: "2026-07-03" },
        preferencePrompt: "cheap outdoor activities with friends",
        searchMode: "fast",
      }),
    );
    const body = await expectJson(response, 200);

    expect(body).toMatchObject({
      location: {
        query: "Queens",
        latitude: 40.7282,
        longitude: -73.7949,
      },
      activities: [
        {
          activityName: "Outdoor Hangout at Flushing Meadows Corona Park",
          placeName: "Flushing Meadows Corona Park",
          source: "osm+reddit",
          confidenceScore: 0.92,
          preferenceMatchScore: 0.95,
          fitsPreference: true,
        },
      ],
      debug: {
        failedUrls: [],
            sourceCounts: {
              osm: 1,
              intentFiltered: 1,
              reviewVerified: 1,
              reddit: 2,
              web: 0,
              merged: 1,
              returned: 1,
        },
      },
    });
    expect(body.queryPlan).toContain("cheap outdoor activities Queens reddit");
    expect(body.debug.searchedQueries).toEqual(body.queryPlan);
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/activities/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

async function expectJson(
  response: Response,
  status: number,
  expected?: unknown,
) {
  expect(response.status).toBe(status);
  const body = await response.json();
  if (expected !== undefined) {
    expect(body).toEqual(expected);
  }
  return body;
}
