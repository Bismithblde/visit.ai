import { sourceQualityScore } from "./source-quality";
import type {
  ActivityBudget,
  ActivityCandidate,
  ActivityCandidateType,
  ActivityCluster,
  ActivityDiscoveryRequest,
  ActivityGroupFit,
} from "./types";

const CANDIDATE_TYPES = new Set<ActivityCandidateType>([
  "place",
  "area",
  "event",
  "activity_type",
  "route",
]);

const BUDGETS = new Set<ActivityBudget>(["low", "medium", "high", "unknown"]);
const GROUP_FITS = new Set<ActivityGroupFit>([
  "solo",
  "couple",
  "small_group",
  "large_group",
  "unknown",
]);

export function postprocessDiscovery(
  request: ActivityDiscoveryRequest,
  candidates: ActivityCandidate[],
  clusters: ActivityCluster[],
) {
  const cleanedCandidates = dedupeCandidates(
    candidates.map(sanitizeCandidate).filter(hasEvidence),
  ).map((candidate) => ({
    ...candidate,
    confidence: scoreCandidate(request, candidate),
  }));

  cleanedCandidates.sort((a, b) => b.confidence - a.confidence);

  const candidateNames = new Set(cleanedCandidates.map((candidate) => candidate.name));
  const cleanedClusters = clusters
    .map((cluster) => sanitizeCluster(cluster, candidateNames))
    .filter((cluster) => cluster.candidateNames.length > 0)
    .sort((a, b) => b.confidence - a.confidence);

  return {
    candidates: cleanedCandidates.slice(0, 24),
    clusters: cleanedClusters.slice(0, 8),
  };
}

function sanitizeCandidate(candidate: ActivityCandidate): ActivityCandidate {
  return {
    name: cleanText(candidate.name).slice(0, 100),
    type: CANDIDATE_TYPES.has(candidate.type) ? candidate.type : "activity_type",
    description: cleanText(candidate.description).slice(0, 500),
    locationHint: cleanText(candidate.locationHint).slice(0, 180),
    budgetFit: BUDGETS.has(candidate.budgetFit) ? candidate.budgetFit : "unknown",
    groupFit: GROUP_FITS.has(candidate.groupFit) ? candidate.groupFit : "unknown",
    tags: uniqueStrings(candidate.tags.map(cleanText).filter(Boolean)).slice(0, 10),
    sourceUrls: uniqueStrings(candidate.sourceUrls.filter(isHttpUrl)).slice(0, 8),
    evidenceSnippets: uniqueStrings(
      candidate.evidenceSnippets.map(cleanText).filter(Boolean),
    ).slice(0, 5),
    confidence: clamp(candidate.confidence),
    needsVerification: true,
  };
}

function sanitizeCluster(
  cluster: ActivityCluster,
  candidateNames: Set<string>,
): ActivityCluster {
  const filteredNames = uniqueStrings(
    cluster.candidateNames.map(cleanText).filter((name) => candidateNames.has(name)),
  );

  return {
    id: slugify(cluster.id || cluster.title),
    title: cleanText(cluster.title).slice(0, 100),
    theme: cleanText(cluster.theme).slice(0, 80),
    description: cleanText(cluster.description).slice(0, 400),
    candidateNames: filteredNames,
    tags: uniqueStrings(cluster.tags.map(cleanText).filter(Boolean)).slice(0, 10),
    sourceUrls: uniqueStrings(cluster.sourceUrls.filter(isHttpUrl)).slice(0, 10),
    confidence: clamp(cluster.confidence),
    needsVerification: true,
  };
}

function dedupeCandidates(candidates: ActivityCandidate[]) {
  const byKey = new Map<string, ActivityCandidate>();

  for (const candidate of candidates) {
    const key = normalizeCandidateName(candidate.name);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    byKey.set(key, mergeCandidates(existing, candidate));
  }

  return [...byKey.values()];
}

function mergeCandidates(
  existing: ActivityCandidate,
  incoming: ActivityCandidate,
): ActivityCandidate {
  const primary =
    incoming.sourceUrls.length + incoming.evidenceSnippets.length >
    existing.sourceUrls.length + existing.evidenceSnippets.length
      ? incoming
      : existing;

  return {
    ...primary,
    description: longerText(existing.description, incoming.description),
    locationHint: longerText(existing.locationHint, incoming.locationHint),
    tags: uniqueStrings([...existing.tags, ...incoming.tags]).slice(0, 12),
    sourceUrls: uniqueStrings([...existing.sourceUrls, ...incoming.sourceUrls]).slice(
      0,
      10,
    ),
    evidenceSnippets: uniqueStrings([
      ...existing.evidenceSnippets,
      ...incoming.evidenceSnippets,
    ]).slice(0, 6),
    confidence: Math.max(existing.confidence, incoming.confidence),
    needsVerification: true,
  };
}

function scoreCandidate(
  request: ActivityDiscoveryRequest,
  candidate: ActivityCandidate,
) {
  const haystack = [
    candidate.name,
    candidate.description,
    candidate.locationHint,
    ...candidate.tags,
  ]
    .join(" ")
    .toLowerCase();

  const preferenceScore =
    request.preferences.filter((preference) =>
      haystack.includes(preference.toLowerCase()),
    ).length / Math.max(request.preferences.length, 1);
  const budgetScore =
    candidate.budgetFit === request.budget
      ? 1
      : candidate.budgetFit === "unknown"
        ? 0.45
        : 0.15;
  const groupScore = groupFitScore(request.groupSize, candidate.groupFit);
  const sourceScore =
    candidate.sourceUrls.reduce(
      (sum, url) => sum + sourceQualityScore(url),
      0,
    ) / Math.max(candidate.sourceUrls.length, 1);
  const repeatScore = Math.min(candidate.sourceUrls.length / 3, 1);
  const noveltyScore = noveltyFit(candidate);

  return clamp(
    candidate.confidence * 0.22 +
      preferenceScore * 0.18 +
      budgetScore * 0.16 +
      groupScore * 0.16 +
      sourceScore * 0.14 +
      repeatScore * 0.08 +
      noveltyScore * 0.06,
  );
}

function groupFitScore(groupSize: number, groupFit: ActivityGroupFit) {
  if (groupFit === "unknown") {
    return 0.5;
  }

  if (groupSize <= 1) {
    return groupFit === "solo" ? 1 : 0.45;
  }

  if (groupSize === 2) {
    return groupFit === "couple" || groupFit === "small_group" ? 1 : 0.45;
  }

  if (groupSize <= 6) {
    return groupFit === "small_group" || groupFit === "large_group" ? 1 : 0.35;
  }

  return groupFit === "large_group" ? 1 : 0.3;
}

function noveltyFit(candidate: ActivityCandidate) {
  const text = `${candidate.description} ${candidate.tags.join(" ")}`.toLowerCase();
  return ["niche", "unique", "hidden", "local", "unusual", "offbeat"].some(
    (term) => text.includes(term),
  )
    ? 1
    : 0.35;
}

function normalizeCandidateName(name: string) {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(the|nyc|new york|queens)\b/g, " ")
    .replace(/\bcorona\b/g, " ")
    .replace(/\b(mall|center|centre|park|plaza|marketplace)\b$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasEvidence(candidate: ActivityCandidate) {
  return candidate.name && (candidate.sourceUrls.length > 0 || candidate.evidenceSnippets.length > 0);
}

function cleanText(value: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function longerText(a: string, b: string) {
  return a.length >= b.length ? a : b;
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

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "activity-cluster"
  );
}
