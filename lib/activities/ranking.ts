import { sourceQualityScore } from "@/lib/activity-discovery/source-quality";
import type {
  ActivityRecord,
  ActivityRequest,
  ActivityResponseItem,
  ActivityTagName,
  ParsedPreference,
  QualityCheck,
} from "./types";

export function qualityCheck(
  activities: ActivityRecord[],
  parsed: ParsedPreference,
): QualityCheck {
  const totalActivities = activities.length;
  const important = parsed.importantTags;
  const matchingImportantTags =
    important.length === 0
      ? totalActivities
      : activities.filter((activity) =>
          activity.tags.some(
            (tag) => important.includes(tag.tag as ActivityTagName) && tag.weight > 0,
          ),
        ).length;
  const averageConfidence =
    activities.reduce((sum, activity) => sum + activity.confidenceScore, 0) /
    Math.max(totalActivities, 1);
  const evidenceCoverage =
    activities.filter((activity) => activity.sources.length > 0).length /
    Math.max(totalActivities, 1);
  const reasons: string[] = [];

  if (totalActivities < 12) reasons.push("not_enough_total_activities");
  if (important.length > 0 && matchingImportantTags < 10) {
    reasons.push("not_enough_important_tag_matches");
  }
  if (averageConfidence < 0.55) reasons.push("low_average_confidence");
  if (evidenceCoverage < 0.6) reasons.push("low_evidence_coverage");

  return {
    isEnough: reasons.length === 0,
    totalActivities,
    matchingImportantTags,
    averageConfidence: clamp01(averageConfidence),
    evidenceCoverage: clamp01(evidenceCoverage),
    reasons,
  };
}

export function rankActivities(
  activities: ActivityRecord[],
  parsed: ParsedPreference,
  budget: string | undefined,
  request?: Pick<ActivityRequest, "groupSize" | "dates">,
) {
  return activities
    .map((activity) => {
      const components = scoreComponents(activity, parsed, budget, request);
      const score =
        components.preferenceMatch * 0.34 +
        activity.confidenceScore * 0.18 +
        components.sourceEvidence * 0.14 +
        components.localSignal * 0.12 +
        components.groupFit * 0.08 +
        components.dateFit * 0.04 +
        components.freshness * 0.05 +
        components.priceFit * 0.05;

      return {
        activity,
        score: clamp01(score),
        reason: recommendationReason(activity, components, parsed),
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function toResponseItem(
  activity: ActivityRecord,
  score: number,
  recommendationReason: string,
): ActivityResponseItem {
  const tags = activity.tags
    .map((tag) => tag.tag as ActivityTagName)
    .filter((tag, index, array) => array.indexOf(tag) === index)
    .slice(0, 8);
  const evidence = activity.sources.slice(0, 5).map((source) => ({
    url: source.url,
    title: source.title ?? undefined,
    snippet: source.snippet ?? undefined,
    sourceType: source.sourceType,
  }));
  const sourceConfidence =
    activity.sources.reduce((sum, source) => sum + source.confidence, 0) /
    Math.max(activity.sources.length, 1);

  return {
    id: activity.id,
    name: activity.name,
    description: activity.description,
    tags,
    sourceConfidence: clamp01(sourceConfidence || activity.confidenceScore),
    sourceUrls: activity.sources.map((source) => source.url).filter(unique).slice(0, 8),
    evidence,
    location: buildLocation(activity),
    priceEstimate: priceLabel(activity.priceLevel),
    groupSizeRange: buildGroupSizeRange(activity),
    indoorOutdoor: activity.indoorOutdoor ?? undefined,
    recommendationReason,
    score,
  };
}

function scoreComponents(
  activity: ActivityRecord,
  parsed: ParsedPreference,
  budget: string | undefined,
  request?: Pick<ActivityRequest, "groupSize" | "dates">,
) {
  const tagMap = new Map(activity.tags.map((tag) => [tag.tag, tag]));
  const positiveWeights = Object.entries(parsed.tagWeights).filter(
    ([, weight]) => (weight ?? 0) > 0,
  );
  const preferenceMatch =
    positiveWeights.length === 0
      ? 0.55
      : clamp01(
          positiveWeights.reduce((sum, [tag, weight]) => {
            const activityTag = tagMap.get(tag);
            return sum + (activityTag ? Math.max(weight ?? 0, 0) * activityTag.confidence : 0);
          }, 0) /
            positiveWeights.reduce((sum, [, weight]) => sum + Math.max(weight ?? 0, 0), 0),
        );
  const sourceEvidence = clamp01(activity.sources.length / 4);
  const localSignal = clamp01(
    activity.sources.reduce((best, source) => {
      if (source.sourceType === "reddit" || source.sourceType === "local_blog") return 1;
      return Math.max(best, sourceQualityScore(source.url));
    }, 0),
  );
  const freshness = freshnessScore(activity.lastVerifiedAt ?? activity.updatedAt);
  const priceFit = priceFitScore(activity.priceLevel, budget);
  const groupFit = groupFitScore(activity, request?.groupSize);
  const dateFit = dateFitScore(activity, request?.dates);

  return {
    preferenceMatch,
    sourceEvidence,
    localSignal,
    freshness,
    priceFit,
    groupFit,
    dateFit,
  };
}

function recommendationReason(
  activity: ActivityRecord,
  components: ReturnType<typeof scoreComponents>,
  parsed: ParsedPreference,
) {
  const matchedTag = parsed.importantTags.find((tag) =>
    activity.tags.some((activityTag) => activityTag.tag === tag),
  );

  if (matchedTag) return `Matches your ${matchedTag.replace("_", " ")} preference`;
  if (components.groupFit >= 0.95) return "Fits your group size";
  if (components.localSignal >= 0.9) return "Mentioned by local sources";
  if (activity.priceLevel === "cheap" || activity.priceLevel === "free") {
    return "Good low-cost option";
  }
  if (activity.confidenceScore >= 0.75) return "Strong source confidence";
  return "Useful fit for this destination";
}

function freshnessScore(date: Date | null) {
  if (!date) return 0.35;
  const ageMs = Date.now() - date.getTime();
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 30) return 1;
  if (ageDays <= 180) return 0.75;
  if (ageDays <= 365) return 0.55;
  return 0.3;
}

function priceFitScore(priceLevel: string | null, budget: string | undefined) {
  if (!budget || budget === "unknown" || !priceLevel) return 0.55;
  if (budget === "low") return priceLevel === "free" || priceLevel === "cheap" ? 1 : 0.25;
  if (budget === "medium") return priceLevel === "cheap" || priceLevel === "mid_price" ? 1 : 0.45;
  if (budget === "high") return priceLevel === "expensive" || priceLevel === "mid_price" ? 1 : 0.65;
  return 0.55;
}

function groupFitScore(activity: ActivityRecord, groupSize: number | undefined) {
  if (!groupSize) return 0.6;
  const min = activity.minGroupSize ?? 1;
  const max = activity.maxGroupSize ?? 50;
  if (groupSize >= min && groupSize <= max) return 1;
  if (groupSize < min) return Math.max(0.2, 1 - (min - groupSize) / 6);
  return Math.max(0.15, 1 - (groupSize - max) / 20);
}

function dateFitScore(activity: ActivityRecord, dates: string[] | undefined) {
  if (!dates || dates.length === 0) return 0.6;
  const tagSet = new Set(activity.tags.map((tag) => tag.tag));
  const text = dates.join(" ").toLowerCase();
  if (text.includes("rain") || text.includes("rainy")) {
    return tagSet.has("rainy_day") || activity.indoorOutdoor === "indoor" ? 1 : 0.45;
  }
  if (text.includes("weekend") || text.includes("saturday") || text.includes("sunday")) {
    return 0.75;
  }
  return 0.65;
}

function buildLocation(activity: ActivityRecord) {
  if (!activity.address && activity.latitude === null && activity.longitude === null) {
    return undefined;
  }

  return {
    address: activity.address ?? undefined,
    latitude: activity.latitude ?? undefined,
    longitude: activity.longitude ?? undefined,
  };
}

function buildGroupSizeRange(activity: ActivityRecord) {
  if (activity.minGroupSize == null && activity.maxGroupSize == null) {
    return undefined;
  }

  return {
    min: activity.minGroupSize ?? undefined,
    max: activity.maxGroupSize ?? undefined,
  };
}

function priceLabel(priceLevel: string | null) {
  switch (priceLevel) {
    case "free":
      return "Free";
    case "cheap":
      return "Low cost";
    case "mid_price":
      return "Moderate";
    case "expensive":
      return "Premium";
    default:
      return undefined;
  }
}

function unique<T>(value: T, index: number, array: T[]) {
  return array.indexOf(value) === index;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
