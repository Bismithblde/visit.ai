import { ACTIVITY_TAG_SET } from "./constants";
import { cleanWhitespace } from "./normalize";
import type {
  ActivityRecommendationRequest,
  ActivityRequest,
  ActivityTagName,
  ParsedPreference,
} from "./types";

const TAG_KEYWORDS: Record<ActivityTagName, string[]> = {
  food: ["food", "restaurant", "restaurants", "eat", "eats", "dining", "breakfast", "lunch", "dinner", "cafe", "coffee", "market"],
  outdoor: ["outdoor", "outside", "hike", "park", "parks", "garden", "beach", "nature"],
  museum: ["museum", "museums", "gallery", "galleries", "exhibit", "history"],
  nightlife: ["nightlife", "bar", "bars", "club", "clubs", "late night", "karaoke"],
  shopping: ["shopping", "shop", "shops", "boutique", "market"],
  scenic: ["scenic", "view", "views", "overlook", "waterfront", "sunset"],
  free: ["free", "no cost"],
  cheap: ["cheap", "budget", "low cost", "inexpensive", "affordable"],
  mid_price: ["mid price", "moderate", "not too expensive"],
  expensive: ["expensive", "luxury", "splurge", "premium"],
  local_favorite: ["local", "locals", "local favorite", "neighborhood"],
  hidden_gem: ["hidden", "hidden gem", "underrated", "offbeat", "niche", "secret"],
  touristy: ["tourist", "touristy", "tourist trap", "popular attraction"],
  romantic: ["romantic", "date", "couple", "anniversary"],
  family_friendly: ["family", "kids", "children", "child friendly"],
  rainy_day: ["rain", "rainy", "indoor", "indoors"],
  walking: ["walk", "walking", "stroll", "wander"],
  short_visit: ["short", "quick", "brief", "one hour", "half day"],
  unique: ["unique", "unusual", "weird", "distinctive", "special"],
  seasonal: ["seasonal", "festival", "holiday", "summer", "winter", "spring", "fall"],
};

const NEGATIVE_PREFIXES = [
  "avoid",
  "less",
  "skip",
  "no",
  "not",
  "without",
  "hate",
  "dislike",
];

const POSITIVE_PREFIXES = ["more", "love", "like", "prefer", "interested in"];

export function parseActivityInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return { ok: false as const, error: "Request body must be a JSON object." };
  }

  const record = input as Record<string, unknown>;
  const city = cleanWhitespace(stringValue(record.city) || stringValue(record.location));

  if (!city) {
    return { ok: false as const, error: "city is required." };
  }

  const groupSize = optionalNumber(record.groupSize);
  if (groupSize !== undefined && (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 50)) {
    return {
      ok: false as const,
      error: "groupSize must be an integer between 1 and 50.",
    };
  }

  return {
    ok: true as const,
    request: {
      city,
      region: optionalString(record.region ?? record.state),
      country: optionalString(record.country),
      dates: parseDates(record.dates ?? record.dateRange),
      groupSize,
      budget: parseBudget(record.budget),
      preferences: parsePreferenceText(record.preferences ?? record.preferencePrompt),
      balancePreferences: parseBalancePreferences(record),
    } satisfies ActivityRequest,
  };
}

export function parseRecommendationInput(input: unknown) {
  const parsed = parseActivityInput(input);

  if (!parsed.ok) {
    return parsed;
  }

  const record = input as Record<string, unknown>;
  return {
    ok: true as const,
    request: {
      location: parsed.request.city,
      groupSize: parsed.request.groupSize,
      dateRange: parseDateRange(record.dateRange),
      budget: parsed.request.budget,
      preferencePrompt: parsed.request.preferences,
    } satisfies ActivityRecommendationRequest,
    activityRequest: parsed.request,
  };
}

export function parsePreferences(request: ActivityRequest): ParsedPreference {
  const text = [
    request.preferences,
    ...request.balancePreferences,
    request.budget === "low" ? "cheap free" : "",
    request.budget === "high" ? "expensive" : "",
  ]
    .join(", ")
    .toLowerCase();
  const tagWeights: Partial<Record<ActivityTagName, number>> = {};
  const unmatchedTerms: string[] = [];

  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS) as Array<[ActivityTagName, string[]]>) {
    const matches = keywords.filter((keyword) => text.includes(keyword));

    if (matches.length === 0) {
      continue;
    }

    const polarity = keywordPolarity(text, matches);
    const intensity = POSITIVE_PREFIXES.some((prefix) => text.includes(prefix)) ? 1.5 : 1;
    tagWeights[tag] = clampWeight((tagWeights[tag] ?? 0) + polarity * intensity);
  }

  for (const item of request.balancePreferences) {
    const normalized = item.toLowerCase().trim();
    if (ACTIVITY_TAG_SET.has(normalized as ActivityTagName)) {
      tagWeights[normalized as ActivityTagName] = Math.max(
        tagWeights[normalized as ActivityTagName] ?? 0,
        1,
      );
    } else if (normalized) {
      unmatchedTerms.push(item);
    }
  }

  const importantTags = Object.entries(tagWeights)
    .filter(([, weight]) => (weight ?? 0) > 0)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, 4)
    .map(([tag]) => tag as ActivityTagName);

  return { tagWeights, importantTags, unmatchedTerms };
}

function keywordPolarity(text: string, matches: string[]) {
  for (const match of matches) {
    const index = text.indexOf(match);
    const prefixText = text.slice(0, index);
    const lastClauseBreak = Math.max(
      prefixText.lastIndexOf(","),
      prefixText.lastIndexOf(";"),
      prefixText.lastIndexOf("."),
    );
    const before = prefixText.slice(Math.max(lastClauseBreak + 1, index - 24));
    if (NEGATIVE_PREFIXES.some((prefix) => before.includes(prefix))) {
      return -1;
    }
  }

  return 1;
}

function parseBudget(value: unknown): ActivityRequest["budget"] {
  const text = stringValue(value).toLowerCase();
  if (["$", "low", "cheap", "budget"].includes(text)) return "low";
  if (["$$", "medium", "mid", "moderate"].includes(text)) return "medium";
  if (["$$$", "high", "expensive", "luxury"].includes(text)) return "high";
  return "unknown";
}

function parsePreferenceText(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(stringValue).map(cleanWhitespace).filter(Boolean).join(", ");
  }

  return cleanWhitespace(stringValue(value));
}

function parseBalancePreferences(record: Record<string, unknown>) {
  const raw = record.balancePreferences ?? record.activityBalancePreferences ?? record.tags;
  if (Array.isArray(raw)) {
    return raw.map(stringValue).map(cleanWhitespace).filter(Boolean).slice(0, 12);
  }
  if (typeof raw === "string") {
    return raw.split(",").map(cleanWhitespace).filter(Boolean).slice(0, 12);
  }
  return [];
}

function parseDates(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const range = value as Record<string, unknown>;
    return [range.start, range.end]
      .map(stringValue)
      .map(cleanWhitespace)
      .filter(Boolean)
      .slice(0, 2);
  }

  if (Array.isArray(value)) {
    return value.map(stringValue).map(cleanWhitespace).filter(Boolean).slice(0, 12);
  }
  if (typeof value === "string" && value.trim()) {
    return [cleanWhitespace(value)];
  }
  return undefined;
}

function parseDateRange(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const start = optionalString(record.start);
  const end = optionalString(record.end);

  if (!start && !end) {
    return undefined;
  }

  return { start, end };
}

function optionalString(value: unknown) {
  const text = cleanWhitespace(stringValue(value));
  return text || undefined;
}

function optionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function clampWeight(value: number) {
  return Math.max(-2, Math.min(2, value));
}
