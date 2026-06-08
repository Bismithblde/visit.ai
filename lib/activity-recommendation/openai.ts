import { ACTIVITY_TAG_SET } from "@/lib/activities/constants";
import {
  cleanWhitespace,
  hashStableJson,
  normalizeActivityName,
} from "@/lib/activities/normalize";
import type {
  ActivityRecommendationRequest,
  ActivityTagName,
  SearchCandidate,
} from "@/lib/activities/types";
import type { NormalizedLocation } from "@/lib/activities/location";
import type { CleanedChunk } from "./content";

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

interface ExtractionOutput {
  activities: Array<{
    activityName: string;
    description: string;
    tags: string[];
    locationHint: string;
    priceHint: string;
    indoorOutdoor: string;
    minGroupSize: number;
    maxGroupSize: number;
    evidenceSnippet: string;
    confidence: number;
    needsFallbackVerification: boolean;
  }>;
}

const DEFAULT_MODEL = "gpt-4.1-mini";
export const EXTRACTION_VERSION = "activity-extraction-v2";

export async function generateSearchQueries({
  apiKey,
  request,
  location,
}: {
  apiKey?: string;
  request: ActivityRecommendationRequest;
  location: NormalizedLocation;
}) {
  if (!apiKey) {
    return dedupeQueries(fallbackQueries(request, location));
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_ACTIVITY_QUERY_MODEL || DEFAULT_MODEL,
      instructions: [
        "Generate web search queries for discovering source-backed local activity recommendations.",
        "Maximize coverage, not query count. Avoid semantically redundant queries.",
        "Respect hard constraints in the preference prompt. If the user asks for food only, do not generate museums, parks, nightlife, or shopping queries.",
        "Return concise queries suitable for Tavily search.",
      ].join("\n"),
      input: JSON.stringify({
        location: location.canonicalName,
        groupSize: request.groupSize,
        dateRange: request.dateRange,
        budget: request.budget,
        preferencePrompt: request.preferencePrompt,
      }),
      text: {
        format: {
          type: "json_schema",
          name: "activity_search_queries",
          strict: true,
          schema: querySchema,
        },
      },
    }),
  });

  if (!response.ok) {
    return dedupeQueries(fallbackQueries(request, location));
  }

  const data = (await response.json()) as OpenAIResponse;
  const text = getOutputText(data);
  if (!text) return dedupeQueries(fallbackQueries(request, location));

  try {
    const parsed = JSON.parse(text) as { queries?: string[] };
    return dedupeQueries(parsed.queries ?? fallbackQueries(request, location));
  } catch {
    return dedupeQueries(fallbackQueries(request, location));
  }
}

export async function extractVerifiedActivities({
  apiKey,
  request,
  location,
  chunks,
  query,
}: {
  apiKey: string;
  request: ActivityRecommendationRequest;
  location: NormalizedLocation;
  chunks: CleanedChunk[];
  query: string;
}): Promise<SearchCandidate[]> {
  if (chunks.length === 0) return [];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_ACTIVITY_MODEL || DEFAULT_MODEL,
      instructions: buildExtractionInstructions(),
      input: JSON.stringify({
        request,
        location: location.canonicalName,
        searchIntent: query,
        chunks,
      }),
      text: {
        format: {
          type: "json_schema",
          name: "verified_activity_extraction",
          strict: true,
          schema: extractionSchema,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI extraction failed: ${response.status} ${response.statusText}`);
  }

  const text = getOutputText((await response.json()) as OpenAIResponse);
  if (!text) return [];

  const parsed = JSON.parse(text) as ExtractionOutput;
  const pageUrl = chunks[0]?.url ?? "";
  const pageTitle = chunks[0]?.pageTitle ?? "";

  return (parsed.activities ?? [])
    .filter((activity) => activity.activityName && activity.evidenceSnippet)
    .map((activity) => toSearchCandidate(activity, request, location, query, pageUrl, pageTitle));
}

export function extractionCacheKey(contentHash: string) {
  return `extraction:${contentHash}:${EXTRACTION_VERSION}`;
}

export function requestHash(request: ActivityRecommendationRequest, location: NormalizedLocation) {
  return hashStableJson({
    location: location.normalizedKey,
    groupSize: request.groupSize ?? null,
    dateRange: request.dateRange ?? null,
    budget: request.budget ?? "unknown",
    preferencePrompt: cleanWhitespace(request.preferencePrompt).toLowerCase(),
  });
}

function toSearchCandidate(
  activity: ExtractionOutput["activities"][number],
  request: ActivityRecommendationRequest,
  location: NormalizedLocation,
  query: string,
  url: string,
  title: string,
): SearchCandidate {
  const tags = activity.tags
    .map((tag) => cleanWhitespace(tag).toLowerCase().replace(/\s+/g, "_"))
    .filter((tag): tag is ActivityTagName => ACTIVITY_TAG_SET.has(tag as ActivityTagName))
    .slice(0, 8);

  return {
    name: cleanWhitespace(activity.activityName),
    normalizedName: normalizeActivityName(activity.activityName, location.city),
    city: location.city,
    region: location.region,
    country: location.country,
    description: cleanWhitespace(activity.description).slice(0, 500),
    locationHint: cleanWhitespace(activity.locationHint),
    tags,
    source: {
      sourceType: "other",
      url,
      title,
      snippet: cleanWhitespace(activity.evidenceSnippet).slice(0, 700),
      queryUsed: query,
      confidence: clamp01(activity.confidence),
    },
    priceLevel: normalizePrice(activity.priceHint, request.budget),
    indoorOutdoor: normalizeIndoorOutdoor(activity.indoorOutdoor),
    minGroupSize: normalizeGroupSize(activity.minGroupSize),
    maxGroupSize: normalizeGroupSize(activity.maxGroupSize),
    confidenceScore: clamp01(activity.confidence),
    needsFallbackVerification: activity.needsFallbackVerification,
  };
}

function buildExtractionInstructions() {
  return [
    "Extract activities from the supplied cleaned webpage chunks.",
    "Verify each activity against the same supplied source content in this single response.",
    "Accept only activities with source evidence that supports existence, location relevance, request relevance, and the description.",
    "Use needsFallbackVerification only when the source wording is ambiguous or names are vague.",
    "Do not invent addresses, hours, prices, or coordinates.",
    "Return no activity if the chunk does not support one.",
  ].join("\n");
}

function fallbackQueries(request: ActivityRecommendationRequest, location: NormalizedLocation) {
  const prompt = request.preferencePrompt.toLowerCase();
  const place = location.canonicalName;
  const queries = [`best activities in ${place}`, `unique things to do in ${place}`];

  if (prompt.includes("food") || prompt.includes("restaurant")) {
    return [
      `best food experiences in ${place}`,
      `hidden gem restaurants in ${place}`,
      `group dining experiences in ${place}`,
      `unique food destinations in ${place}`,
      `popular local food recommendations in ${place}`,
    ];
  }

  if (request.groupSize && request.groupSize >= 10) {
    queries.push(`group activities for ${request.groupSize} people in ${place}`);
  }

  if (request.budget === "low") {
    queries.push(`cheap free activities in ${place}`);
  }

  if (prompt) {
    queries.push(`${request.preferencePrompt} in ${place}`);
  }

  return queries;
}

function dedupeQueries(queries: string[]) {
  const seen = new Set<string>();
  return queries
    .map(cleanWhitespace)
    .filter(Boolean)
    .filter((query) => {
      const key = semanticQueryKey(query);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function semanticQueryKey(query: string) {
  return query
    .toLowerCase()
    .replace(/\b(best|top|popular|recommended|recommendations)\b/g, "")
    .replace(/\b(experiences|destinations|spots|places)\b/g, "activities")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePrice(priceHint: string, fallback: ActivityRecommendationRequest["budget"]) {
  const text = priceHint.toLowerCase();
  if (text.includes("free")) return "free";
  if (text.includes("cheap") || text.includes("affordable") || text.includes("$")) return "cheap";
  if (text.includes("expensive") || text.includes("premium") || text.includes("$$$")) {
    return "expensive";
  }
  if (text.includes("moderate") || text.includes("$$")) return "mid_price";
  if (fallback === "low") return "cheap";
  if (fallback === "medium") return "mid_price";
  if (fallback === "high") return "expensive";
  return undefined;
}

function normalizeIndoorOutdoor(value: string) {
  const text = value.toLowerCase();
  if (text.includes("indoor")) return "indoor";
  if (text.includes("outdoor")) return "outdoor";
  if (text.includes("both")) return "both";
  return undefined;
}

function normalizeGroupSize(value: number) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(100, Math.round(value)));
}

function getOutputText(data: OpenAIResponse) {
  if (typeof data.output_text === "string") return data.output_text;
  return (
    data.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string")
      .join("") ?? ""
  );
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

const querySchema = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: { type: "string" },
    },
  },
};

const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["activities"],
  properties: {
    activities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "activityName",
          "description",
          "tags",
          "locationHint",
          "priceHint",
          "indoorOutdoor",
          "minGroupSize",
          "maxGroupSize",
          "evidenceSnippet",
          "confidence",
          "needsFallbackVerification",
        ],
        properties: {
          activityName: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          locationHint: { type: "string" },
          priceHint: { type: "string" },
          indoorOutdoor: { type: "string" },
          minGroupSize: { type: "number" },
          maxGroupSize: { type: "number" },
          evidenceSnippet: { type: "string" },
          confidence: { type: "number" },
          needsFallbackVerification: { type: "boolean" },
        },
      },
    },
  },
};
