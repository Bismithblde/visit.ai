import { createHash } from "crypto";
import type { ActivityRequest, ParsedPreference } from "./types";

export function normalizePlace(value: string | undefined) {
  return cleanWhitespace(value ?? "").toLowerCase();
}

export function normalizeActivityName(name: string, city?: string) {
  const cityTerms = city ? cityAliasTerms(city) : [];
  const suffixPattern = cityTerms.length
    ? new RegExp(`\\b(${cityTerms.map(escapeRegExp).join("|")})\\b`, "g")
    : null;

  let normalized = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(the|a|an|of|at|in|near|best|top)\b/g, " ");

  if (suffixPattern) {
    normalized = normalized.replace(suffixPattern, " ");
  }

  return cleanWhitespace(normalized);
}

export function buildRequestCacheKey(
  request: ActivityRequest,
  parsed: ParsedPreference,
) {
  return `activity:v1:request:${hashStableJson({
    city: normalizePlace(request.city),
    region: normalizePlace(request.region),
    country: normalizePlace(request.country),
    dates: [...(request.dates ?? [])].map(cleanWhitespace).sort(),
    groupSize: request.groupSize ?? null,
    budget: request.budget ?? "unknown",
    tagWeights: sortRecord(parsed.tagWeights),
    unmatchedTerms: [...parsed.unmatchedTerms]
      .map((item) => cleanWhitespace(item).toLowerCase())
      .filter(Boolean)
      .sort(),
  })}`;
}

export function buildSearchCacheKey(query: string) {
  return `activity:v1:tavily:${hashStableJson({ query: cleanWhitespace(query).toLowerCase() })}`;
}

export function cleanWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function hashStableJson(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function sortRecord<T>(record: Partial<Record<string, T>>) {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function cityAliasTerms(city: string) {
  const normalized = normalizePlace(city);
  const terms = [normalized];

  if (normalized === "new york") {
    terms.push("nyc", "new york city");
  }

  return terms.filter(Boolean);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
