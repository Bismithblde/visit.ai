import type {
  ActivityDiscoveryItem,
  ActivityDiscoveryRequest,
  IntentProfile,
  OSMCandidate,
} from "./types";

export const DEFAULT_MINIMUM_PREFERENCE_SCORE = 0.32;

export function fallbackIntentProfile(
  request: ActivityDiscoveryRequest,
): IntentProfile {
  const terms = tokenize(request.preferencePrompt)
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 12);

  return {
    primaryGoal: request.preferencePrompt || "Find activities",
    concepts: terms.map((term) => ({
      term,
      weight: 0.65,
      type: "should" as const,
    })),
    placeTypes: [],
    activityTypes: [],
    attributes: [],
    exclusions: [],
    reviewSearchTerms: terms.slice(0, 8),
    minimumPreferenceScore: DEFAULT_MINIMUM_PREFERENCE_SCORE,
    searchAreaKind: "neighborhood",
    recommendedRadiusMeters: 5000,
    radiusReason:
      "Fallback local-business radius for neighborhood activity discovery.",
  };
}

export function scoreOsmCandidateAgainstIntent(
  candidate: OSMCandidate,
  intent: IntentProfile,
) {
  return scoreTextAgainstIntent(osmSearchText(candidate), intent);
}

export function scoreActivityAgainstIntent(
  activity: ActivityDiscoveryItem,
  intent: IntentProfile,
) {
  return scoreTextAgainstIntent(activitySearchText(activity), intent);
}

export function filterAndRankOsmCandidates(
  candidates: OSMCandidate[],
  intent: IntentProfile,
) {
  const minimum = Math.max(0.12, intent.minimumPreferenceScore * 0.6);
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreOsmCandidateAgainstIntent(candidate, intent),
    }))
    .sort((a, b) => b.score - a.score);

  const filtered = scored
    .filter(({ score }) => score >= minimum)
    .map(({ candidate }) => candidate);

  return filtered.length > 0 ? filtered : scored.slice(0, 12).map(({ candidate }) => candidate);
}

export function selectOsmCandidatesForReview(
  candidates: OSMCandidate[],
  intent: IntentProfile,
  limit: number,
) {
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreOsmCandidateAgainstIntent(candidate, intent),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function intentTerms(intent: IntentProfile) {
  return uniqueStrings([
    ...intent.concepts
      .filter((concept) => concept.type !== "avoid")
      .sort((a, b) => b.weight - a.weight)
      .map((concept) => concept.term),
    ...intent.placeTypes,
    ...intent.activityTypes,
    ...intent.attributes,
    ...intent.reviewSearchTerms,
  ]).slice(0, 12);
}

export function activitySearchText(activity: ActivityDiscoveryItem) {
  return [
    activity.activityName,
    activity.placeName,
    activity.location?.label,
    activity.source,
    activity.tags.join(" "),
    activity.osm?.category,
    activity.osm ? rawTagText(activity.osm.tags) : "",
    activity.evidenceSummary,
    activity.reason,
    activity.reviewSummary,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreTextAgainstIntent(text: string, intent: IntentProfile) {
  const haystack = normalizeText(text);
  const positive = [
    ...intent.concepts.filter((concept) => concept.type !== "avoid"),
    ...intent.placeTypes.map((term) => ({ term, weight: 0.7, type: "should" as const })),
    ...intent.activityTypes.map((term) => ({ term, weight: 0.65, type: "should" as const })),
    ...intent.attributes.map((term) => ({ term, weight: 0.55, type: "should" as const })),
  ].filter((concept) => concept.term);
  const avoid = [
    ...intent.concepts.filter((concept) => concept.type === "avoid").map((concept) => concept.term),
    ...intent.exclusions,
  ];

  if (positive.length === 0) {
    return 0.45;
  }

  let totalWeight = 0;
  let matchedWeight = 0;

  for (const concept of positive) {
    const weight = clamp(concept.weight || 0.5);
    totalWeight += weight;
    if (matchesTerm(haystack, concept.term)) {
      matchedWeight += weight;
    }
  }

  const avoidPenalty = avoid.some((term) => matchesTerm(haystack, term)) ? 0.28 : 0;
  const score = totalWeight > 0 ? matchedWeight / totalWeight : 0.45;
  return clamp(score - avoidPenalty);
}

function osmSearchText(candidate: OSMCandidate) {
  return [
    candidate.activityName,
    candidate.placeName,
    candidate.category,
    candidate.tags.join(" "),
    candidate.possibleActivities.join(" "),
    rawTagText(candidate.rawTags),
  ]
    .join(" ")
    .toLowerCase();
}

function rawTagText(tags: Record<string, string>) {
  return Object.entries(tags)
    .flatMap(([key, value]) => [key, value, `${key}:${value}`])
    .join(" ");
}

function matchesTerm(haystack: string, term: string) {
  const normalized = normalizeText(term);
  if (!normalized) {
    return false;
  }

  if (haystack.includes(normalized)) {
    return true;
  }

  const tokens = tokenize(normalized).filter((token) => !STOP_WORDS.has(token));
  if (tokens.length === 0) {
    return false;
  }

  return tokens.every((token) => haystack.includes(token));
}

function tokenize(value: string) {
  return normalizeText(value).split(" ").filter((term) => term.length > 2);
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[_:/-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

const STOP_WORDS = new Set([
  "and",
  "are",
  "but",
  "eat",
  "for",
  "from",
  "get",
  "have",
  "into",
  "just",
  "like",
  "near",
  "not",
  "the",
  "this",
  "that",
  "thing",
  "things",
  "want",
  "with",
  "would",
]);
