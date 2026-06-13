import type {
  ActivityDiscoveryItem,
  ActivityDiscoveryRequest,
  DiscoverySource,
  OSMCandidate,
  SocialCandidate,
} from "./types";

const MAX_VERIFICATION_CANDIDATES = 36;
const MAX_RETURNED_ACTIVITIES = 24;

export function buildMergedActivities({
  request,
  osmCandidates,
  socialCandidates,
}: {
  request: ActivityDiscoveryRequest;
  osmCandidates: OSMCandidate[];
  socialCandidates: SocialCandidate[];
}) {
  const byKey = new Map<string, ActivityDiscoveryItem>();

  for (const candidate of osmCandidates) {
    mergeInto(byKey, osmToActivity(request, candidate));
  }

  for (const candidate of socialCandidates) {
    mergeInto(byKey, socialToActivity(request, candidate));
  }

  return diversify(
    [...byKey.values()].sort(preliminarySort),
    request,
  ).slice(0, MAX_VERIFICATION_CANDIDATES);
}

export function finalRankAndDiversify(
  activities: ActivityDiscoveryItem[],
  request: ActivityDiscoveryRequest,
) {
  const rankedFits = activities
    .filter((activity) => activity.fitsPreference)
    .sort((a, b) => finalScore(b) - finalScore(a));
  const rankedFallbacks = activities
    .filter((activity) => !activity.fitsPreference)
    .filter((activity) => activity.preferenceMatchScore >= 0.3 || activity.source !== "osm")
    .sort((a, b) => finalScore(b) - finalScore(a))
    .map((activity) => ({
      ...activity,
      possibleConcerns: uniqueStrings([
        "Returned as a fallback because strict preference verification filtered out all matches.",
        ...activity.possibleConcerns,
      ]).slice(0, 6),
    }));

  return diversify(
    rankedFits.length > 0 ? rankedFits : rankedFallbacks,
    request,
  ).slice(0, MAX_RETURNED_ACTIVITIES);
}

function osmToActivity(
  request: ActivityDiscoveryRequest,
  candidate: OSMCandidate,
): ActivityDiscoveryItem {
  const tags = uniqueStrings([...candidate.tags, ...candidate.possibleActivities]);
  const provider = candidate.provider ?? "osm";
  const preferenceMatchScore = lexicalPreferenceScore(request.preferencePrompt, [
    ...tags,
    candidate.placeName,
    candidate.category,
    ...Object.entries(candidate.rawTags).flatMap(([key, value]) => [key, value]),
  ]);
  const activityName =
    candidate.possibleActivities[0] && candidate.possibleActivities[0] !== candidate.placeName
      ? `${titleCase(candidate.possibleActivities[0])} at ${candidate.placeName}`
      : candidate.placeName;

  return {
    activityName,
    placeName: candidate.placeName,
    location: {
      label: candidate.placeName,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
    },
    source: provider === "geoapify" ? "geoapify" : "osm",
    sourceUrls: [],
    osm:
      provider === "osm"
        ? {
            id: candidate.osmId,
            type: candidate.osmType,
            tags: candidate.rawTags,
            category: candidate.category,
          }
        : undefined,
    provider: {
      name: provider,
      id: candidate.osmId,
      categories: candidate.providerCategories,
      formattedAddress: candidate.formattedAddress,
      distanceMeters: candidate.distanceMeters,
      estimatedCredits: candidate.estimatedCredits,
    },
    tags,
    confidenceScore: provider === "geoapify" ? 0.74 : 0.58,
    preferenceMatchScore,
    evidenceSummary:
      provider === "geoapify"
        ? `${candidate.placeName} is listed by Geoapify as ${candidate.providerCategories?.join(", ") || candidate.category}.`
        : `${candidate.placeName} is listed in OpenStreetMap as ${candidate.category}.`,
    reason: `${provider === "geoapify" ? "Geoapify" : "OSM"} identifies ${candidate.placeName} as a physical place suitable for ${candidate.possibleActivities
      .slice(0, 3)
      .join(", ")}.`,
    fitsPreference:
      preferenceMatchScore >= (provider === "geoapify" ? 0.25 : 0.35) ||
      (provider === "geoapify" && hasDirectProviderMatch(candidate)),
    missingInfo: ["Current hours, pricing, and crowd levels are not verified."],
    possibleConcerns: candidate.tags.includes("weather dependent")
      ? ["Weather dependent."]
      : [],
  };
}

function socialToActivity(
  request: ActivityDiscoveryRequest,
  candidate: SocialCandidate,
): ActivityDiscoveryItem {
  const placeName = candidate.placeName || candidate.activityName;
  return {
    activityName: candidate.activityName,
    placeName,
    location: { label: placeName },
    source: candidate.sourceType === "reddit" ? "reddit" : "web",
    sourceUrls: [candidate.sourceUrl],
    tags: uniqueStrings(candidate.tags),
    confidenceScore: candidate.confidenceScore,
    preferenceMatchScore: Math.max(
      candidate.preferenceRelevanceScore,
      lexicalPreferenceScore(request.preferencePrompt, candidate.tags),
    ),
    verificationSources: [candidate.sourceUrl],
    reviewSummary: candidate.evidenceSummary,
    evidenceSummary: candidate.evidenceSummary,
    reason: candidate.evidenceSummary,
    fitsPreference: candidate.sentiment !== "negative",
    missingInfo: ["Exact location details may need verification."],
    possibleConcerns:
      candidate.sentiment === "mixed" ? ["Social evidence is mixed."] : [],
  };
}

function mergeInto(
  byKey: Map<string, ActivityDiscoveryItem>,
  incoming: ActivityDiscoveryItem,
) {
  const key = mergeKey(incoming);
  const existing = byKey.get(key) ?? fuzzyExisting(byKey, incoming);

  if (!existing) {
    byKey.set(key, incoming);
    return;
  }

  byKey.delete(mergeKey(existing));
  byKey.set(mergeKey(existing), mergeActivities(existing, incoming));
}

function mergeActivities(
  existing: ActivityDiscoveryItem,
  incoming: ActivityDiscoveryItem,
): ActivityDiscoveryItem {
  const primary =
    finalScore(incoming) > finalScore(existing) || existing.source === "osm"
      ? incoming
      : existing;
  const sources = new Set<DiscoverySource>([existing.source, incoming.source]);
  const source = mergedSource(sources);

  return {
    ...primary,
    activityName: bestName(existing.activityName, incoming.activityName),
    placeName: existing.placeName ?? incoming.placeName,
    location: mergeLocation(existing.location, incoming.location),
    source,
    sourceUrls: uniqueStrings([...existing.sourceUrls, ...incoming.sourceUrls]).slice(0, 8),
    osm: existing.osm ?? incoming.osm,
    tags: uniqueStrings([...existing.tags, ...incoming.tags]).slice(0, 18),
    confidenceScore: clamp(
      Math.max(existing.confidenceScore, incoming.confidenceScore) +
        sourceDiversityBoost(source),
    ),
    preferenceMatchScore: Math.max(
      existing.preferenceMatchScore,
      incoming.preferenceMatchScore,
    ),
    evidenceSummary: joinEvidence(existing.evidenceSummary, incoming.evidenceSummary),
    reason: joinEvidence(existing.reason, incoming.reason),
    rating: existing.rating ?? incoming.rating,
    reviewCount: existing.reviewCount ?? incoming.reviewCount,
    verificationSources: uniqueStrings([
      ...(existing.verificationSources ?? []),
      ...(incoming.verificationSources ?? []),
    ]).slice(0, 8),
    reviewSummary: joinOptionalEvidence(existing.reviewSummary, incoming.reviewSummary),
    fitsPreference: existing.fitsPreference || incoming.fitsPreference,
    missingInfo: uniqueStrings([...existing.missingInfo, ...incoming.missingInfo]).slice(0, 6),
    possibleConcerns: uniqueStrings([
      ...existing.possibleConcerns,
      ...incoming.possibleConcerns,
    ]).slice(0, 6),
  };
}

function diversify(
  activities: ActivityDiscoveryItem[],
  request: ActivityDiscoveryRequest,
) {
  const explicitlyWantsSingleType = /\b(parks?|museums?|restaurants?|cafes?|hikes?|food)\b/i.test(
    request.preferencePrompt,
  );
  if (explicitlyWantsSingleType) {
    return activities;
  }

  const seen = new Map<string, number>();
  return activities
    .map((activity) => {
      const category = broadCategory(activity);
      const count = seen.get(category) ?? 0;
      seen.set(category, count + 1);
      return {
        activity,
        adjustedScore: finalScore(activity) - Math.max(0, count - 2) * 0.12,
      };
    })
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .map((item) => item.activity);
}

function preliminarySort(a: ActivityDiscoveryItem, b: ActivityDiscoveryItem) {
  return finalScore(b) - finalScore(a);
}

function finalScore(activity: ActivityDiscoveryItem) {
  const sourceScore =
    activity.source === "mixed" || activity.source.includes("+")
      ? 1
      : activity.source === "geoapify"
        ? 0.82
      : activity.source === "reddit"
        ? 0.86
        : activity.source === "web"
          ? 0.72
          : 0.62;
  const mentionScore = Math.min(activity.sourceUrls.length / 3, 1);

  return (
    activity.preferenceMatchScore * 0.36 +
    activity.confidenceScore * 0.28 +
    sourceScore * 0.18 +
    mentionScore * 0.1 +
    uniquenessScore(activity) * 0.08
  );
}

function lexicalPreferenceScore(prompt: string, tags: string[]) {
  const terms = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);

  if (terms.length === 0) {
    return 0.45;
  }

  const haystack = tags.join(" ").toLowerCase();
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return clamp(matches / Math.min(terms.length, 8));
}

function fuzzyExisting(
  byKey: Map<string, ActivityDiscoveryItem>,
  incoming: ActivityDiscoveryItem,
) {
  for (const activity of byKey.values()) {
    if (activity.osm?.id && incoming.osm?.id && activity.osm.id === incoming.osm.id) {
      return activity;
    }

    if (normalizedName(activity.placeName ?? activity.activityName) === normalizedName(incoming.placeName ?? incoming.activityName)) {
      return activity;
    }

    if (tokenSimilarity(activity.activityName, incoming.activityName) >= 0.72) {
      return activity;
    }

    if (geoClose(activity, incoming) && tokenSimilarity(activity.placeName ?? "", incoming.placeName ?? "") >= 0.5) {
      return activity;
    }
  }

  return null;
}

function mergeKey(activity: ActivityDiscoveryItem) {
  if (activity.osm?.id) {
    return `osm:${activity.osm.type}:${activity.osm.id}`;
  }

  return normalizedName(activity.placeName ?? activity.activityName);
}

function normalizedName(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(the|a|an|at|in|near|best|top)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSimilarity(a: string, b: string) {
  const aTokens = new Set(normalizedName(a).split(" ").filter(Boolean));
  const bTokens = new Set(normalizedName(b).split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }

  const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function geoClose(a: ActivityDiscoveryItem, b: ActivityDiscoveryItem) {
  const aLat = a.location?.latitude;
  const aLon = a.location?.longitude;
  const bLat = b.location?.latitude;
  const bLon = b.location?.longitude;

  if ([aLat, aLon, bLat, bLon].some((value) => typeof value !== "number")) {
    return false;
  }

  return haversineMeters(aLat!, aLon!, bLat!, bLon!) <= 120;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const earth = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return earth * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function mergedSource(sources: Set<DiscoverySource>): DiscoverySource {
  if (sources.size >= 3) {
    return "mixed";
  }

  if (sources.has("osm") && sources.has("reddit")) {
    return "osm+reddit";
  }

  if (sources.has("osm") && sources.has("web")) {
    return "osm+web";
  }

  if (sources.has("geoapify") && sources.has("osm")) {
    return "mixed";
  }

  if (sources.has("geoapify") && sources.has("reddit")) {
    return "geoapify+reddit";
  }

  if (sources.has("geoapify") && sources.has("web")) {
    return "geoapify+web";
  }

  if (sources.has("osm+reddit") || sources.has("osm+web") || sources.has("mixed")) {
    return "mixed";
  }

  return [...sources][0] ?? "mixed";
}

function sourceDiversityBoost(source: DiscoverySource) {
  return source === "mixed" || source.includes("+") ? 0.12 : 0;
}

function broadCategory(activity: ActivityDiscoveryItem) {
  const tags = activity.tags.join(" ").toLowerCase();
  if (tags.includes("food")) return "food";
  if (tags.includes("outdoor") || tags.includes("scenic")) return "outdoor";
  if (tags.includes("cultural") || tags.includes("museum")) return "culture";
  if (tags.includes("active") || tags.includes("walking")) return "active";
  if (tags.includes("nightlife")) return "nightlife";
  return activity.osm?.category ?? activity.source;
}

function hasDirectProviderMatch(candidate: OSMCandidate) {
  const haystack = [
    candidate.placeName,
    candidate.category,
    ...(candidate.providerCategories ?? []),
    ...candidate.tags,
  ]
    .join(" ")
    .toLowerCase();

  return /\b(bubble[_ ]tea|boba|milk tea|tea|bakery|dessert|cafe|restaurant)\b/.test(
    haystack,
  );
}

function uniquenessScore(activity: ActivityDiscoveryItem) {
  const haystack = `${activity.tags.join(" ")} ${activity.evidenceSummary}`.toLowerCase();
  return /\b(hidden|unique|local|unusual|offbeat|quiet)\b/.test(haystack) ? 1 : 0.35;
}

function bestName(a: string, b: string) {
  if (a.includes(" at ")) return a;
  if (b.includes(" at ")) return b;
  return a.length >= b.length ? a : b;
}

function mergeLocation(
  a: ActivityDiscoveryItem["location"],
  b: ActivityDiscoveryItem["location"],
) {
  return {
    label: a?.label ?? b?.label,
    latitude: a?.latitude ?? b?.latitude,
    longitude: a?.longitude ?? b?.longitude,
  };
}

function joinEvidence(a: string, b: string) {
  if (!a) return b;
  if (!b || a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a} ${b}`.slice(0, 700);
}

function joinOptionalEvidence(a: string | undefined, b: string | undefined) {
  const joined = joinEvidence(a ?? "", b ?? "");
  return joined || undefined;
}

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
