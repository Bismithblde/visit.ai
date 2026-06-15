import type {
  ActivityDiscoveryRequest,
  DiscoveryLocation,
  IntentProfile,
} from "./types";

export interface BusinessSearchArea {
  mode: "circle" | "rect";
  source: "llm-radius" | "bbox" | "fallback";
  centerLatitude?: number;
  centerLongitude?: number;
  radiusMeters?: number;
  boundingBox?: [number, number, number, number];
  bboxWidthKm?: number;
  bboxHeightKm?: number;
  requestedRadiusMeters?: number;
  radiusReason: string;
}

interface RadiusBounds {
  min: number;
  max: number;
  fallback: number;
}

const RADIUS_BOUNDS: Record<IntentProfile["searchAreaKind"], RadiusBounds> = {
  neighborhood: { min: 3000, max: 8000, fallback: 5000 },
  city: { min: 8000, max: 20000, fallback: 12000 },
  metro: { min: 15000, max: 40000, fallback: 25000 },
  region: { min: 15000, max: 40000, fallback: 25000 },
  unknown: { min: 5000, max: 15000, fallback: 8000 },
};

export function resolveBusinessSearchArea(
  location: DiscoveryLocation,
  intent: IntentProfile,
  searchMode: ActivityDiscoveryRequest["searchMode"],
): BusinessSearchArea {
  const bboxMetrics: Pick<BusinessSearchArea, "bboxWidthKm" | "bboxHeightKm"> = location.boundingBox
    ? boundingBoxMetrics(location.boundingBox)
    : {};

  if (typeof location.latitude === "number" && typeof location.longitude === "number") {
    const bounds = RADIUS_BOUNDS[intent.searchAreaKind] ?? RADIUS_BOUNDS.unknown;
    const requestedRadius =
      Number.isFinite(intent.recommendedRadiusMeters) &&
      intent.recommendedRadiusMeters > 0
        ? intent.recommendedRadiusMeters
        : defaultRadiusForMode(bounds, searchMode);
    const radiusMeters = clampNumber(requestedRadius, bounds.min, bounds.max);
    const radiusNote =
      requestedRadius === radiusMeters
        ? ""
        : ` Requested ${Math.round(requestedRadius)}m was clamped to ${radiusMeters}m for ${intent.searchAreaKind}.`;

    return {
      mode: "circle",
      source: "llm-radius",
      centerLatitude: location.latitude,
      centerLongitude: location.longitude,
      radiusMeters,
      boundingBox: location.boundingBox,
      bboxWidthKm: bboxMetrics.bboxWidthKm,
      bboxHeightKm: bboxMetrics.bboxHeightKm,
      requestedRadiusMeters: Math.round(requestedRadius),
      radiusReason: `${intent.radiusReason || "LLM-selected local business search radius."}${radiusNote}`,
    };
  }

  if (location.boundingBox) {
    return {
      mode: "rect",
      source: "bbox",
      boundingBox: location.boundingBox,
      bboxWidthKm: bboxMetrics.bboxWidthKm,
      bboxHeightKm: bboxMetrics.bboxHeightKm,
      radiusReason: "No usable geocoded center was available, so provider search falls back to the Nominatim bounding box.",
    };
  }

  return {
    mode: "circle",
    source: "fallback",
    radiusMeters: defaultRadiusForMode(RADIUS_BOUNDS.unknown, searchMode),
    radiusReason: "No usable geocoded center or bounding box was available.",
  };
}

export function overpassSelectorForSearchArea(
  area: BusinessSearchArea,
  fallbackLocation: DiscoveryLocation,
) {
  if (
    area.mode === "circle" &&
    typeof area.centerLatitude === "number" &&
    typeof area.centerLongitude === "number" &&
    typeof area.radiusMeters === "number"
  ) {
    return `(around:${area.radiusMeters},${area.centerLatitude},${area.centerLongitude})`;
  }

  const bbox = area.boundingBox ?? fallbackLocation.boundingBox;
  if (bbox) {
    const [south, north, west, east] = bbox;
    return `(${south},${west},${north},${east})`;
  }

  return `(around:${RADIUS_BOUNDS.unknown.fallback},${fallbackLocation.latitude ?? 0},${fallbackLocation.longitude ?? 0})`;
}

function defaultRadiusForMode(
  bounds: RadiusBounds,
  searchMode: ActivityDiscoveryRequest["searchMode"],
) {
  if (searchMode === "fast") {
    return clampNumber(bounds.fallback * 0.85, bounds.min, bounds.max);
  }

  if (searchMode === "deep") {
    return clampNumber(bounds.fallback * 1.25, bounds.min, bounds.max);
  }

  return bounds.fallback;
}

function boundingBoxMetrics([south, north, west, east]: [
  number,
  number,
  number,
  number,
]) {
  const midLatitude = (south + north) / 2;
  const bboxHeightKm = haversineKm(south, west, north, west);
  const bboxWidthKm = haversineKm(midLatitude, west, midLatitude, east);

  return {
    bboxWidthKm: roundOneDecimal(bboxWidthKm),
    bboxHeightKm: roundOneDecimal(bboxHeightKm),
  };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radiusKm = 6371;
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(degreesToRadians(lat1)) *
      Math.cos(degreesToRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * radiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.round(Math.max(min, Math.min(max, value)));
}

function roundOneDecimal(value: number) {
  return Math.round(value * 10) / 10;
}
