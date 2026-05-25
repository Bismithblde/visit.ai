import type {
  ActivityBudget,
  ActivityDiscoveryRequest,
} from "./types";

interface ValidationResult {
  ok: boolean;
  request?: ActivityDiscoveryRequest;
  error?: string;
}

const BUDGETS = new Set(["low", "medium", "high", "unknown"]);
const SEARCH_MODES = new Set(["fast", "balanced", "deep"]);

export function parseDiscoveryRequest(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const record = input as Record<string, unknown>;
  const location = stringValue(record.location).trim();

  if (!location) {
    return { ok: false, error: "location is required." };
  }

  const groupSize = numberValue(record.groupSize);

  if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 50) {
    return {
      ok: false,
      error: "groupSize must be an integer between 1 and 50.",
    };
  }

  return {
    ok: true,
    request: {
      location,
      groupSize,
      budget: parseBudget(record.budget),
      preferences: parsePreferences(record.preferences),
      searchMode: parseSearchMode(record.searchMode),
    },
  };
}

function parseBudget(value: unknown): ActivityBudget {
  const budget = stringValue(value).toLowerCase();
  return BUDGETS.has(budget) ? (budget as ActivityBudget) : "unknown";
}

function parseSearchMode(value: unknown): ActivityDiscoveryRequest["searchMode"] {
  const searchMode = stringValue(value).toLowerCase();
  return SEARCH_MODES.has(searchMode)
    ? (searchMode as ActivityDiscoveryRequest["searchMode"])
    : "balanced";
}

function parsePreferences(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map(stringValue)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  return [];
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
