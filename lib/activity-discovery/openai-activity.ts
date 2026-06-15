import type {
  ActivityDiscoveryItem,
  ActivityDiscoveryRequest,
  IntentProfile,
  OSMCandidate,
  PageContent,
  SocialCandidate,
} from "./types";
import { fallbackIntentProfile } from "./intent";

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

interface QueryPlanResult {
  queries?: string[];
  relevantOsmCategories?: string[];
  inferredTags?: string[];
  intentProfile?: Partial<IntentProfile>;
}

interface SocialExtractionResult {
  candidates?: SocialCandidate[];
}

interface VerificationResult {
  activities?: Array<Partial<ActivityDiscoveryItem> & { activityName: string }>;
}

export class OpenAIActivityClient {
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.OPENAI_ACTIVITY_MODEL || DEFAULT_OPENAI_MODEL,
  ) {}

  async generateQueryPlan(request: ActivityDiscoveryRequest) {
    const fallback = fallbackQueries(request);
    const result = await this.responsesJson<QueryPlanResult>(
      "activity_discovery_query_plan",
      [
        "Generate concise Tavily search queries for activity discovery.",
        "Return 5-10 queries: 2 general city activity queries, 3-5 preference-specific Reddit queries, and 1-2 web/blog fallback queries.",
        "Also return broad OSM categories/tags that may be relevant. Be lenient.",
        "Return a generic intentProfile from the user prompt. Do not special-case domains; extract weighted concepts, desired place/activity types, attributes, exclusions, and review search terms that could apply to any prompt.",
        "For Google Places, act as a provider orchestrator: identify concrete searchable subjects first in googlePlaceSubjects, then produce one googlePlaceQueries entry per subject.",
        "Do not combine separate subjects into one Places query. For example, food + boba should produce separate subjects and separate queries. Prefer common Google Places category phrasing: boba should usually become bubble tea.",
        "Examples: 'boba + food' => googlePlaceSubjects ['bubble tea','food'] and googlePlaceQueries ['bubble tea','food']; 'parks and museums' => ['parks','museums']; 'bubble tea' => ['bubble tea']; 'dim sum + bakery' => ['dim sum','bakery'].",
        "Google Places queries should be short business/place search phrases, not full sentences and not Reddit/blog/web queries.",
        "Classify the practical provider search area for local activity/business discovery. Choose searchAreaKind from neighborhood, city, metro, region, or unknown, and recommend a radius in meters from the geocoded center. For neighborhoods such as Flushing Queens, prefer roughly 5000m unless the prompt clearly needs a wider city/metro search.",
      ].join("\n"),
      JSON.stringify({ request }),
      queryPlanSchema,
    );
    const fallbackIntent = fallbackIntentProfile(request);

    return {
      queries: uniqueStrings(
        (result.queries ?? fallback).map(cleanText).filter(Boolean),
      ).slice(0, 10),
      relevantOsmCategories: uniqueStrings(
        (result.relevantOsmCategories ?? []).map(cleanText).filter(Boolean),
      ),
      inferredTags: uniqueStrings(
        (result.inferredTags ?? []).map(cleanText).filter(Boolean),
      ),
      intentProfile: sanitizeIntentProfile(result.intentProfile, fallbackIntent),
    };
  }

  async extractSocialCandidates(
    request: ActivityDiscoveryRequest,
    pages: PageContent[],
  ): Promise<SocialCandidate[]> {
    if (pages.length === 0) {
      return [];
    }

    const result = await this.responsesJson<SocialExtractionResult>(
      "activity_discovery_social_extraction",
      [
        "Extract activities from reduced Reddit/web content for a travel/activity recommendation endpoint.",
        "Use only supplied content. Do not invent exact addresses, hours, prices, ratings, or source URLs.",
        "Infer useful tags such as free, cheap, outdoor, indoor, scenic, hidden gem, local favorite, date-friendly, group-friendly, active, relaxing, food, nightlife, cultural, seasonal, crowded, quiet, walking-heavy, low walking, weather dependent.",
      ].join("\n"),
      JSON.stringify({
        request,
        pages: pages.map((page) => ({
          url: page.url,
          sourceType: page.sourceType,
          title: page.title ?? "",
          content: page.content,
        })),
      }),
      socialExtractionSchema,
    );

    return (result.candidates ?? [])
      .map((candidate) => sanitizeSocialCandidate(candidate))
      .filter((candidate): candidate is SocialCandidate => Boolean(candidate));
  }

  async verifyAndRankActivities({
    request,
    activities,
  }: {
    request: ActivityDiscoveryRequest;
    activities: ActivityDiscoveryItem[];
  }) {
    if (activities.length === 0) {
      return [];
    }

    const result = await this.responsesJson<VerificationResult>(
      "activity_discovery_verification",
      [
        "Verify and rerank activity candidates against the original preference prompt, group size, date range, tags, OSM evidence, and social evidence.",
        "Be stricter than early filtering. A generic OSM place should be fitsPreference=false unless its name, raw OSM tags, or review/social evidence match the user's intent.",
        "Preserve activityName values exactly so they can be matched back to candidates.",
      ].join("\n"),
      JSON.stringify({
        request,
        activities: activities.map((activity) => ({
          activityName: activity.activityName,
          placeName: activity.placeName,
          source: activity.source,
          tags: activity.tags,
          osm: activity.osm,
          provider: activity.provider,
          evidenceSummary: activity.evidenceSummary,
          sourceUrls: activity.sourceUrls,
          confidenceScore: activity.confidenceScore,
          preferenceMatchScore: activity.preferenceMatchScore,
          rating: activity.rating,
          reviewCount: activity.reviewCount,
          verificationSources: activity.verificationSources,
          reviewSummary: activity.reviewSummary,
          missingInfo: activity.missingInfo,
          possibleConcerns: activity.possibleConcerns,
        })),
      }),
      verificationSchema,
    );

    const byName = new Map(activities.map((activity) => [activity.activityName, activity]));

    return (result.activities ?? [])
      .map((verified) => {
        const original = byName.get(verified.activityName);
        if (!original) {
          return null;
        }

        return sanitizeVerifiedActivity({ ...original, ...verified });
      })
      .filter((activity): activity is ActivityDiscoveryItem => Boolean(activity));
  }

  private async responsesJson<T>(
    schemaName: string,
    instructions: string,
    input: string,
    schema: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        instructions,
        input,
        text: {
          format: {
            type: "json_schema",
            name: schemaName,
            strict: true,
            schema,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI failed with ${response.status} ${response.statusText}: ${await compactResponseText(response)}`,
      );
    }

    const text = getOutputText((await response.json()) as OpenAIResponse);

    if (!text) {
      throw new Error("OpenAI returned no text output");
    }

    return JSON.parse(text) as T;
  }
}

export function fallbackQueries(request: ActivityDiscoveryRequest) {
  const location = request.cityOrLocation;
  const prompt = request.preferencePrompt || "things to do";
  const dateText = request.dateRange?.start
    ? ` ${request.dateRange.start}${request.dateRange.end ? ` to ${request.dateRange.end}` : ""}`
    : "";

  return uniqueStrings([
    `best things to do in ${location} reddit`,
    `${location} hidden gems reddit`,
    `${prompt} in ${location} reddit`,
    `${location} local favorite activities reddit`,
    `${location} parks museums food activities reddit`,
    `${prompt} in ${location} blog`,
    `things to do in ${location}${dateText}`,
  ]);
}

export function fallbackVerify(
  request: ActivityDiscoveryRequest,
  activities: ActivityDiscoveryItem[],
) {
  return activities.map((activity) => ({
    ...activity,
    fitsPreference:
      activity.preferenceMatchScore >= 0.5 ||
      (activity.source !== "osm" && activity.preferenceMatchScore >= 0.35),
    reason: activity.reason || fallbackReason(request, activity),
  }));
}

export function filterOsmCandidates(
  candidates: OSMCandidate[],
  relevantCategories: string[],
  inferredTags: string[],
) {
  if (relevantCategories.length === 0 && inferredTags.length === 0) {
    return candidates;
  }

  const categoryTerms = relevantCategories.map((item) => item.toLowerCase());
  const tagTerms = inferredTags.map((item) => item.toLowerCase());

  return candidates.filter((candidate) => {
    const haystack = [
      candidate.category,
      candidate.placeName,
      ...candidate.tags,
      ...candidate.possibleActivities,
    ]
      .join(" ")
      .toLowerCase();

    const categoryMatch = categoryTerms.some((term) => haystack.includes(term));
    const tagMatch = tagTerms.some((term) => haystack.includes(term));

    return categoryMatch || tagMatch;
  });
}

function sanitizeIntentProfile(
  profile: Partial<IntentProfile> | undefined,
  fallback: IntentProfile,
): IntentProfile {
  return {
    primaryGoal: cleanText(profile?.primaryGoal ?? fallback.primaryGoal).slice(0, 240),
    concepts: (profile?.concepts ?? fallback.concepts)
      .map((concept) => ({
        term: cleanText(concept.term).slice(0, 80),
        weight: clamp(concept.weight ?? 0.5),
        type: ["must", "should", "avoid"].includes(concept.type)
          ? concept.type
          : ("should" as const),
      }))
      .filter((concept) => concept.term)
      .slice(0, 16),
    placeTypes: cleanList(profile?.placeTypes ?? fallback.placeTypes, 12),
    activityTypes: cleanList(profile?.activityTypes ?? fallback.activityTypes, 12),
    attributes: cleanList(profile?.attributes ?? fallback.attributes, 16),
    exclusions: cleanList(profile?.exclusions ?? fallback.exclusions, 12),
    reviewSearchTerms: cleanList(
      profile?.reviewSearchTerms ?? fallback.reviewSearchTerms,
      12,
    ),
    googlePlaceSubjects: cleanList(
      profile?.googlePlaceSubjects ?? fallback.googlePlaceSubjects,
      12,
    ),
    googlePlaceQueries: cleanList(
      profile?.googlePlaceQueries ?? fallback.googlePlaceQueries,
      12,
    ),
    minimumPreferenceScore: clamp(
      profile?.minimumPreferenceScore ?? fallback.minimumPreferenceScore,
    ),
    searchAreaKind: sanitizeSearchAreaKind(
      profile?.searchAreaKind ?? fallback.searchAreaKind,
    ),
    recommendedRadiusMeters: sanitizeRadius(
      profile?.recommendedRadiusMeters ?? fallback.recommendedRadiusMeters,
      fallback.recommendedRadiusMeters,
    ),
    radiusReason:
      cleanText(profile?.radiusReason ?? fallback.radiusReason).slice(0, 280) ||
      fallback.radiusReason,
  };
}

function sanitizeSocialCandidate(
  candidate: Partial<SocialCandidate>,
): SocialCandidate | null {
  const activityName = cleanText(candidate.activityName ?? "");
  const sourceUrl = cleanText(candidate.sourceUrl ?? "");

  if (!activityName || !isHttpUrl(sourceUrl)) {
    return null;
  }

  return {
    activityName: activityName.slice(0, 120),
    placeName: cleanText(candidate.placeName ?? "").slice(0, 120) || undefined,
    sourceUrl,
    sourceType: candidate.sourceType ?? "other",
    tags: uniqueStrings((candidate.tags ?? []).map(cleanText).filter(Boolean)).slice(0, 14),
    sentiment: ["positive", "mixed", "negative", "unknown"].includes(
      candidate.sentiment ?? "",
    )
      ? candidate.sentiment!
      : "unknown",
    evidenceSummary: cleanText(candidate.evidenceSummary ?? "").slice(0, 500),
    confidenceScore: clamp(candidate.confidenceScore ?? 0.45),
    preferenceRelevanceScore: clamp(candidate.preferenceRelevanceScore ?? 0.45),
  };
}

function sanitizeVerifiedActivity(
  activity: Partial<ActivityDiscoveryItem> & { activityName: string },
): ActivityDiscoveryItem {
  return {
    activityName: cleanText(activity.activityName).slice(0, 120),
    placeName: cleanText(activity.placeName ?? "").slice(0, 120) || undefined,
    location: activity.location,
    source: activity.source ?? "mixed",
    sourceUrls: uniqueStrings((activity.sourceUrls ?? []).filter(isHttpUrl)).slice(0, 8),
    osm: activity.osm,
    provider: activity.provider,
    tags: uniqueStrings((activity.tags ?? []).map(cleanText).filter(Boolean)).slice(0, 16),
    confidenceScore: clamp(activity.confidenceScore ?? 0.5),
    preferenceMatchScore: clamp(activity.preferenceMatchScore ?? 0.5),
    rating: optionalPositiveNumber(activity.rating),
    reviewCount: optionalPositiveNumber(activity.reviewCount),
    verificationSources: uniqueStrings(
      (activity.verificationSources ?? []).filter(isHttpUrl),
    ).slice(0, 8),
    reviewSummary: cleanText(activity.reviewSummary ?? "").slice(0, 500) || undefined,
    evidenceSummary: cleanText(activity.evidenceSummary ?? "").slice(0, 600),
    reason: cleanText(activity.reason ?? "").slice(0, 600),
    fitsPreference: activity.fitsPreference !== false,
    missingInfo: uniqueStrings((activity.missingInfo ?? []).map(cleanText).filter(Boolean)).slice(0, 6),
    possibleConcerns: uniqueStrings(
      (activity.possibleConcerns ?? []).map(cleanText).filter(Boolean),
    ).slice(0, 6),
  };
}

function cleanList(values: string[], limit: number) {
  return uniqueStrings(values.map(cleanText).filter(Boolean)).slice(0, limit);
}

function optionalPositiveNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function sanitizeSearchAreaKind(value: unknown): IntentProfile["searchAreaKind"] {
  return ["neighborhood", "city", "metro", "region", "unknown"].includes(
    String(value),
  )
    ? (value as IntentProfile["searchAreaKind"])
    : "unknown";
}

function sanitizeRadius(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.round(parsed);
}

function getOutputText(data: OpenAIResponse) {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  return (
    data.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string")
      .join("") ?? ""
  );
}

function fallbackReason(
  request: ActivityDiscoveryRequest,
  activity: ActivityDiscoveryItem,
) {
  const groupText =
    request.groupSize > 2 ? ` for a group of ${request.groupSize}` : "";
  return `${activity.activityName} fits${groupText} because it matches tags like ${activity.tags
    .slice(0, 3)
    .join(", ") || "local activity"} and has ${activity.source} evidence.`;
}

function cleanText(value: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function compactResponseText(response: Response) {
  try {
    return (await response.text()).replace(/\s+/g, " ").trim().slice(0, 1000) || "empty response body";
  } catch {
    return "unreadable response body";
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function clamp(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

const queryPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["queries", "relevantOsmCategories", "inferredTags", "intentProfile"],
  properties: {
    queries: {
      type: "array",
      items: { type: "string" },
    },
    relevantOsmCategories: {
      type: "array",
      items: { type: "string" },
    },
    inferredTags: {
      type: "array",
      items: { type: "string" },
    },
    intentProfile: {
      type: "object",
      additionalProperties: false,
      required: [
        "primaryGoal",
        "concepts",
        "placeTypes",
        "activityTypes",
        "attributes",
        "exclusions",
        "reviewSearchTerms",
        "googlePlaceSubjects",
        "googlePlaceQueries",
        "minimumPreferenceScore",
        "searchAreaKind",
        "recommendedRadiusMeters",
        "radiusReason",
      ],
      properties: {
        primaryGoal: { type: "string" },
        concepts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["term", "weight", "type"],
            properties: {
              term: { type: "string" },
              weight: { type: "number" },
              type: { type: "string", enum: ["must", "should", "avoid"] },
            },
          },
        },
        placeTypes: { type: "array", items: { type: "string" } },
        activityTypes: { type: "array", items: { type: "string" } },
        attributes: { type: "array", items: { type: "string" } },
        exclusions: { type: "array", items: { type: "string" } },
        reviewSearchTerms: { type: "array", items: { type: "string" } },
        googlePlaceSubjects: { type: "array", items: { type: "string" } },
        googlePlaceQueries: { type: "array", items: { type: "string" } },
        minimumPreferenceScore: { type: "number" },
        searchAreaKind: {
          type: "string",
          enum: ["neighborhood", "city", "metro", "region", "unknown"],
        },
        recommendedRadiusMeters: { type: "number" },
        radiusReason: { type: "string" },
      },
    },
  },
};

const socialExtractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "activityName",
          "placeName",
          "sourceUrl",
          "sourceType",
          "tags",
          "sentiment",
          "evidenceSummary",
          "confidenceScore",
          "preferenceRelevanceScore",
        ],
        properties: {
          activityName: { type: "string" },
          placeName: { type: "string" },
          sourceUrl: { type: "string" },
          sourceType: {
            type: "string",
            enum: [
              "reddit",
              "local_blog",
              "travel_site",
              "event_page",
              "review_site",
              "listicle",
              "other",
            ],
          },
          tags: { type: "array", items: { type: "string" } },
          sentiment: {
            type: "string",
            enum: ["positive", "mixed", "negative", "unknown"],
          },
          evidenceSummary: { type: "string" },
          confidenceScore: { type: "number" },
          preferenceRelevanceScore: { type: "number" },
        },
      },
    },
  },
};

const activitySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "activityName",
    "placeName",
    "source",
    "sourceUrls",
    "tags",
    "confidenceScore",
    "preferenceMatchScore",
    "rating",
    "reviewCount",
    "verificationSources",
    "reviewSummary",
    "evidenceSummary",
    "reason",
    "fitsPreference",
    "missingInfo",
    "possibleConcerns",
  ],
  properties: {
    activityName: { type: "string" },
    placeName: { type: "string" },
    source: {
      type: "string",
      enum: [
        "google_places",
        "osm",
        "reddit",
        "web",
        "google_places+reddit",
        "google_places+web",
        "osm+reddit",
        "osm+web",
        "mixed",
      ],
    },
    sourceUrls: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    confidenceScore: { type: "number" },
    preferenceMatchScore: { type: "number" },
    rating: { type: "number" },
    reviewCount: { type: "number" },
    verificationSources: { type: "array", items: { type: "string" } },
    reviewSummary: { type: "string" },
    evidenceSummary: { type: "string" },
    reason: { type: "string" },
    fitsPreference: { type: "boolean" },
    missingInfo: { type: "array", items: { type: "string" } },
    possibleConcerns: { type: "array", items: { type: "string" } },
  },
};

const verificationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["activities"],
  properties: {
    activities: {
      type: "array",
      items: activitySchema,
    },
  },
};
