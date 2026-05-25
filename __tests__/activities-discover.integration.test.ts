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
    process.env.OPENAI_ACTIVITY_MODEL = "gpt-test";
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
    const response = await POST(jsonRequest({ location: "", groupSize: 2 }));

    await expectJson(response, 400, { error: "location is required." });
  });

  test("returns 500 when required server env is missing", async () => {
    delete process.env.TAVILY_API_KEY;

    const response = await POST(
      jsonRequest({ location: "Queens", groupSize: 4 }),
    );

    await expectJson(response, 500, { error: "Missing TAVILY_API_KEY" });
  });

  test("runs the Tavily to OpenAI discovery flow and returns postprocessed results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://api.tavily.com/search") {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer tavily-test-key",
          "Content-Type": "application/json",
        });

        return jsonResponse({
          results: [
            {
              title: "Hidden Queens activities",
              url: "https://www.timeout.com/newyork/things-to-do/hidden-queens",
              content: "A local guide to arcade bars and night markets.",
              score: 0.9,
            },
          ],
        });
      }

      if (url === "https://api.tavily.com/extract") {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer tavily-test-key",
          "Content-Type": "application/json",
        });

        return jsonResponse({
          results: [
            {
              url: "https://www.timeout.com/newyork/things-to-do/hidden-queens",
              title: "Hidden Queens activities",
              raw_content:
                "Hidden Queens arcade bars, night markets, and small-group activities.",
            },
          ],
        });
      }

      if (url === "https://api.openai.com/v1/responses") {
        const body = JSON.parse(String(init?.body));

        expect(init?.headers).toMatchObject({
          Authorization: "Bearer openai-test-key",
          "Content-Type": "application/json",
        });
        expect(body.model).toBe("gpt-test");
        expect(body.input).toContain("Hidden Queens arcade bars");

        return jsonResponse({
          output_text: JSON.stringify({
            candidates: [
              {
                name: "Hidden Queens Arcade",
                type: "place",
                description:
                  "A hidden local arcade option for small groups in Queens.",
                locationHint: "Queens",
                budgetFit: "low",
                groupFit: "small_group",
                tags: ["arcade", "hidden"],
                sourceUrls: [
                  "https://www.timeout.com/newyork/things-to-do/hidden-queens",
                ],
                evidenceSnippets: ["Hidden Queens arcade bars"],
                confidence: 0.8,
                needsVerification: true,
              },
            ],
            clusters: [
              {
                id: "games-night",
                title: "Games night",
                theme: "arcade",
                description: "Small-group game activities.",
                candidateNames: ["Hidden Queens Arcade"],
                tags: ["arcade"],
                sourceUrls: [
                  "https://www.timeout.com/newyork/things-to-do/hidden-queens",
                ],
                confidence: 0.7,
                needsVerification: true,
              },
            ],
          }),
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      jsonRequest({
        location: "Queens",
        groupSize: 4,
        budget: "low",
        preferences: ["arcade", "hidden"],
        searchMode: "fast",
      }),
    );
    const body = await expectJson(response, 200);

    expect(body).toMatchObject({
      location: "Queens",
      candidates: [
        {
          name: "Hidden Queens Arcade",
          budgetFit: "low",
          groupFit: "small_group",
          needsVerification: true,
        },
      ],
      clusters: [
        {
          id: "games-night",
          candidateNames: ["Hidden Queens Arcade"],
          needsVerification: true,
        },
      ],
      debug: {
        failedUrls: [],
      },
    });
    expect(body.queryPlan).toContain("niche activities in Queens reddit");
    expect(body.debug.searchedQueries).toEqual(body.queryPlan);
    expect(fetchMock).toHaveBeenCalled();
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
