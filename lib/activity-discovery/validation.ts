import type { ActivityDateRange, ActivityDiscoveryRequest } from "./types";

interface ValidationResult {
  ok: boolean;
  request?: ActivityDiscoveryRequest;
  error?: string;
}

const SEARCH_MODES = new Set(["fast", "balanced", "deep"]);

export function parseDiscoveryRequest(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const record = input as Record<string, unknown>;
  const cityOrLocation = (
    stringValue(record.cityOrLocation) || stringValue(record.location)
  ).trim();

  if (!cityOrLocation) {
    return { ok: false, error: "cityOrLocation is required." };
  }

  const groupSize = numberValue(record.groupSize);

  if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 50) {
    return {
      ok: false,
      error: "groupSize must be an integer between 1 and 50.",
    };
  }

  const dateRange = parseDateRange(record.dateRange);

  if (dateRange === false) {
    return {
      ok: false,
      error: "dateRange must use YYYY-MM-DD start/end values.",
    };
  }

  const debugProviders = parseDebugProviders(record.debugProviders);

  return {
    ok: true,
    request: {
      cityOrLocation,
      groupSize,
      dateRange,
      preferencePrompt: parsePreferencePrompt(record),
      searchMode: parseSearchMode(record.searchMode),
      ...(debugProviders ? { debugProviders } : {}),
    },
  };
}

function parsePreferencePrompt(record: Record<string, unknown>) {
  const direct = stringValue(record.preferencePrompt).trim();

  if (direct) {
    return direct.slice(0, 1200);
  }

  const legacy = record.preferences;
  if (Array.isArray(legacy)) {
    return legacy.map(stringValue).map((item) => item.trim()).filter(Boolean).join(", ");
  }

  return stringValue(legacy).trim().slice(0, 1200);
}

function parseDateRange(value: unknown): ActivityDateRange | undefined | false {
  if (value == null || value === "") {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const start = stringValue(record.start).trim();
  const end = stringValue(record.end).trim();

  if ((start && !isIsoDate(start)) || (end && !isIsoDate(end))) {
    return false;
  }

  if (start && end && start > end) {
    return false;
  }

  if (!start && !end) {
    return undefined;
  }

  return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

function parseSearchMode(value: unknown): ActivityDiscoveryRequest["searchMode"] {
  const searchMode = stringValue(value).toLowerCase();
  return SEARCH_MODES.has(searchMode)
    ? (searchMode as ActivityDiscoveryRequest["searchMode"])
    : "balanced";
}

function parseDebugProviders(
  value: unknown,
): ActivityDiscoveryRequest["debugProviders"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    tavily: record.tavily !== false,
    googlePlaces: record.googlePlaces !== false,
    osm: record.osm !== false,
  };
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  return Number.NaN;
}
