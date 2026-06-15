import {
  overpassSelectorForSearchArea,
  type BusinessSearchArea,
} from "./search-area";
import type { ActivityDiscoveryRequest, DiscoveryLocation, OSMCandidate } from "./types";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_RADIUS_METERS = 18000;
const MAX_OSM_CANDIDATES = 180;
const MAX_TARGETED_OSM_CANDIDATES = 120;

interface NominatimResult {
  lat?: string;
  lon?: string;
  display_name?: string;
  boundingbox?: string[];
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

interface OverpassElement {
  id: number;
  type: string;
  lat?: number;
  lon?: number;
  center?: {
    lat?: number;
    lon?: number;
  };
  tags?: Record<string, string>;
}

export async function retrieveOsmCandidates(
  request: ActivityDiscoveryRequest,
  signal?: AbortSignal,
) {
  const location = await geocodeLocation(request.cityOrLocation, signal);

  if (!location.latitude || !location.longitude) {
    return { location, candidates: [] };
  }

  const elements = await queryOverpass(location, signal);
  const candidates = elements
    .map(normalizeOverpassElement)
    .filter((candidate): candidate is OSMCandidate => Boolean(candidate))
    .sort((a, b) => namedScore(b) - namedScore(a))
    .slice(0, MAX_OSM_CANDIDATES);

  return { location, candidates };
}

export async function resolveOsmLocation(
  request: ActivityDiscoveryRequest,
  signal?: AbortSignal,
) {
  return geocodeLocation(request.cityOrLocation, signal);
}

export async function retrieveTargetedOsmCandidates(
  location: DiscoveryLocation,
  searchTerms: string[],
  searchArea?: BusinessSearchArea,
  signal?: AbortSignal,
) {
  if (!location.latitude || !location.longitude) {
    return [];
  }

  const terms = normalizeSearchTerms(searchTerms);
  if (terms.length === 0) {
    return [];
  }

  const elements = await queryOverpass(location, signal, terms, searchArea);
  return elements
    .map(normalizeOverpassElement)
    .filter((candidate): candidate is OSMCandidate => Boolean(candidate))
    .sort((a, b) => namedScore(b) - namedScore(a))
    .slice(0, MAX_TARGETED_OSM_CANDIDATES);
}

async function geocodeLocation(
  query: string,
  signal?: AbortSignal,
): Promise<DiscoveryLocation> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
    addressdetails: "1",
  });
  const response = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "visit-ai-activity-discovery/0.1",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Nominatim failed with ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as NominatimResult[];
  const first = data[0];
  const latitude = numberOrUndefined(first?.lat);
  const longitude = numberOrUndefined(first?.lon);

  return {
    query,
    latitude,
    longitude,
    boundingBox: parseBoundingBox(first?.boundingbox),
  };
}

async function queryOverpass(
  location: DiscoveryLocation,
  signal?: AbortSignal,
  targetedTerms: string[] = [],
  searchArea?: BusinessSearchArea,
) {
  const query =
    targetedTerms.length > 0
      ? buildTargetedOverpassQuery(location, targetedTerms, searchArea)
      : buildOverpassQuery(location);
  const params = new URLSearchParams({ data: query });
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": "visit-ai-activity-discovery/0.1",
    },
    body: params.toString(),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Overpass failed with ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OverpassResponse;
  return data.elements ?? [];
}

function buildOverpassQuery(location: DiscoveryLocation) {
  const selector = location.boundingBox
    ? bboxSelector(location.boundingBox)
    : aroundSelector(location.latitude ?? 0, location.longitude ?? 0);
  const selectors = [
    `nwr["leisure"~"^(park|garden|nature_reserve|sports_centre|playground)$"]${selector};`,
    `nwr["tourism"~"^(museum|attraction|viewpoint|gallery|zoo|aquarium)$"]${selector};`,
    `nwr["amenity"~"^(restaurant|cafe|marketplace|cinema|theatre|library|arts_centre)$"]${selector};`,
    `nwr["shop"]${selector};`,
    `nwr["historic"]${selector};`,
    `nwr["natural"~"^(beach|wood|water|peak|cave_entrance)$"]${selector};`,
    `nwr["route"~"^(hiking|bicycle|foot)$"]${selector};`,
  ];

  return `[out:json][timeout:18];(${selectors.join("")});out center tags 260;`;
}

function buildTargetedOverpassQuery(
  location: DiscoveryLocation,
  searchTerms: string[],
  searchArea?: BusinessSearchArea,
) {
  const selector = searchArea
    ? overpassSelectorForSearchArea(searchArea, location)
    : location.boundingBox
      ? bboxSelector(location.boundingBox)
      : aroundSelector(location.latitude ?? 0, location.longitude ?? 0);
  const regex = searchTermsToRegex(searchTerms);
  const selectors = [
    `nwr["name"~"${regex}",i]["amenity"]${selector};`,
    `nwr["name"~"${regex}",i]["shop"]${selector};`,
    `nwr["name"~"${regex}",i]["tourism"]${selector};`,
    `nwr["brand"~"${regex}",i]${selector};`,
    `nwr["operator"~"${regex}",i]${selector};`,
    `nwr["cuisine"~"${regex}",i]${selector};`,
    `nwr["shop"~"${regex}",i]${selector};`,
    `nwr["amenity"~"${regex}",i]${selector};`,
  ];

  return `[out:json][timeout:14];(${selectors.join("")});out center tags 180;`;
}

function bboxSelector([south, north, west, east]: [number, number, number, number]) {
  return `(${south},${west},${north},${east})`;
}

function aroundSelector(latitude: number, longitude: number) {
  return `(around:${DEFAULT_RADIUS_METERS},${latitude},${longitude})`;
}

function normalizeOverpassElement(element: OverpassElement): OSMCandidate | null {
  const tags = element.tags ?? {};
  const name = tags.name || tags["official_name"] || tags["short_name"];
  const category = primaryCategory(tags);

  if (!category || !name) {
    return null;
  }

  const generated = tagsForCategory(category, tags);
  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;

  return {
    activityName: generated.possibleActivities[0] ?? name,
    placeName: name,
    osmId: String(element.id),
    osmType: element.type,
    latitude,
    longitude,
    rawTags: tags,
    category,
    tags: uniqueStrings([...generated.tags, ...tagsToSearchTokens(tags)]).slice(0, 24),
    possibleActivities: generated.possibleActivities,
  };
}

function primaryCategory(tags: Record<string, string>) {
  for (const key of ["leisure", "tourism", "amenity", "shop", "historic", "natural", "route"]) {
    if (tags[key]) {
      return `${key}:${tags[key]}`;
    }
  }

  return "";
}

function tagsForCategory(category: string, tags: Record<string, string>) {
  const value = category.split(":")[1] ?? "";
  const base = new Set<string>();
  const possible = new Set<string>();

  if (category.startsWith("leisure:")) {
    base.add("outdoor");
    base.add("group-friendly");
    possible.add("outdoor hangout");
    if (value === "park" || value === "garden") {
      ["walk", "picnic", "relaxing", "photography", "casual date"].forEach((item) =>
        possible.add(item),
      );
      ["scenic", "relaxing", "good for talking"].forEach((item) => base.add(item));
    }
    if (value === "sports_centre" || value === "playground") {
      ["active", "family-friendly"].forEach((item) => base.add(item));
      possible.add("active group activity");
    }
  }

  if (category.startsWith("tourism:")) {
    ["cultural", "touristy"].forEach((item) => base.add(item));
    possible.add(value === "viewpoint" ? "scenic viewpoint" : "visit attraction");
    if (["museum", "gallery"].includes(value)) {
      ["indoor", "rainy day", "good for talking"].forEach((item) => base.add(item));
    }
  }

  if (category.startsWith("amenity:")) {
    if (["restaurant", "cafe", "marketplace"].includes(value)) {
      ["food", "indoor", "group-friendly"].forEach((item) => base.add(item));
      possible.add(value === "marketplace" ? "market crawl" : "food stop");
    } else {
      ["indoor", "cultural"].forEach((item) => base.add(item));
      possible.add(value.replace(/_/g, " "));
    }
  }

  if (category.startsWith("shop:")) {
    ["indoor", "local business"].forEach((item) => base.add(item));
    possible.add(`${value.replace(/_/g, " ")} stop`);
  }

  if (category.startsWith("historic:")) {
    ["cultural", "scenic", "walking-heavy"].forEach((item) => base.add(item));
    possible.add("historic walk");
  }

  if (category.startsWith("natural:")) {
    ["outdoor", "scenic", "weather dependent"].forEach((item) => base.add(item));
    possible.add(value === "peak" ? "scenic hike" : "nature visit");
  }

  if (category.startsWith("route:")) {
    ["outdoor", "active", "walking-heavy"].forEach((item) => base.add(item));
    possible.add(`${value} route`);
  }

  if (tags.fee === "no") {
    base.add("free");
  }

  return { tags: [...base], possibleActivities: [...possible] };
}

function tagsToSearchTokens(tags: Record<string, string>) {
  const ignoredKeys = new Set([
    "addr:housenumber",
    "addr:postcode",
    "phone",
    "website",
  ]);

  return Object.entries(tags)
    .filter(([key, value]) => value && !ignoredKeys.has(key))
    .flatMap(([key, value]) => [
      key.replace(/[:_]/g, " "),
      value.replace(/_/g, " "),
      `${key}:${value}`.replace(/_/g, " "),
    ])
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 2 && item.length <= 80);
}

function normalizeSearchTerms(terms: string[]) {
  return uniqueStrings(
    terms
      .flatMap((term) => [term, ...term.split(/\s+/)])
      .map((term) =>
        term
          .toLowerCase()
          .replace(/[_:/-]+/g, " ")
          .replace(/[^a-z0-9 ]+/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(
        (term) =>
          term.length >= 3 &&
          term.length <= 40 &&
          !TARGETED_OSM_STOP_TERMS.has(term),
      ),
  ).slice(0, 10);
}

function searchTermsToRegex(terms: string[]) {
  return terms
    .map((term) =>
      escapeRegex(term)
        .replace(/\\ /g, "[ _-]+")
        .replace(/\s+/g, "[ _-]+"),
    )
    .join("|");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function namedScore(candidate: OSMCandidate) {
  return (
    (candidate.placeName ? 2 : 0) +
    (candidate.latitude && candidate.longitude ? 1 : 0) +
    Math.min(candidate.tags.length / 10, 1)
  );
}

function parseBoundingBox(value: string[] | undefined) {
  if (!value || value.length !== 4) {
    return undefined;
  }

  const [south, north, west, east] = value.map(Number);
  if ([south, north, west, east].some((item) => !Number.isFinite(item))) {
    return undefined;
  }

  return [south, north, west, east] as [number, number, number, number];
}

function numberOrUndefined(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const TARGETED_OSM_STOP_TERMS = new Set([
  "activity",
  "activities",
  "culture",
  "drink",
  "eat",
  "food",
  "friend",
  "friends",
  "group",
  "local",
  "place",
  "places",
  "thing",
  "things",
  "want",
]);
