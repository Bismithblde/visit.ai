import { intentTerms } from "./intent";
import {
  geoapifyBiasForSearchArea,
  geoapifyFilterForSearchArea,
  type BusinessSearchArea,
} from "./search-area";
import type {
  ActivityDiscoveryRequest,
  DiscoveryLocation,
  IntentProfile,
  OSMCandidate,
} from "./types";

const GEOAPIFY_PLACES_URL = "https://api.geoapify.com/v2/places";
const RESULTS_PER_CALL = 50;

interface GeoapifyFeatureCollection {
  features?: GeoapifyFeature[];
}

interface GeoapifyFeature {
  geometry?: {
    coordinates?: [number, number];
  };
  properties?: {
    place_id?: string;
    name?: string;
    formatted?: string;
    address_line1?: string;
    address_line2?: string;
    categories?: string[];
    lat?: number;
    lon?: number;
    distance?: number;
    city?: string;
    street?: string;
    housenumber?: string;
  };
}

export interface GeoapifyRetrievalResult {
  candidates: OSMCandidate[];
  debug: {
    calls: number;
    estimatedCredits: number;
    rawCandidates: number;
    dedupedCandidates: number;
    queries: string[];
    requestFilters: string[];
    requestBiases: string[];
  };
}

interface GeoapifySearchSpec {
  categories: string[];
  name?: string;
  label: string;
}

export async function retrieveGeoapifyCandidates({
  apiKey,
  request,
  location,
  intent,
  searchArea,
}: {
  apiKey: string | undefined;
  request: ActivityDiscoveryRequest;
  location: DiscoveryLocation;
  intent: IntentProfile;
  searchArea: BusinessSearchArea;
}): Promise<GeoapifyRetrievalResult> {
  if (!apiKey || !location.latitude || !location.longitude) {
    return emptyGeoapifyResult();
  }

  const specs = buildGeoapifySearchSpecs(request, intent).slice(
    0,
    geoapifyCallLimit(request.searchMode),
  );
  const filter = geoapifyFilterForSearchArea(searchArea);
  const bias = geoapifyBiasForSearchArea(searchArea);
  const settled = await Promise.allSettled(
    specs.map((spec) => searchGeoapify({ apiKey, filter, bias, spec })),
  );
  const rawCandidates = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const candidates = dedupeGeoapifyCandidates(rawCandidates);

  return {
    candidates,
    debug: {
      calls: specs.length,
      estimatedCredits: specs.length,
      rawCandidates: rawCandidates.length,
      dedupedCandidates: candidates.length,
      queries: specs.map(specLabel),
      requestFilters: specs.map(() => filter),
      requestBiases: specs.map(() => bias),
    },
  };
}

function buildGeoapifySearchSpecs(
  request: ActivityDiscoveryRequest,
  intent: IntentProfile,
) {
  const terms = intentTerms(intent);
  const normalizedPrompt = normalizeText(
    `${request.preferencePrompt} ${terms.join(" ")}`,
  );
  const categories = categoriesForIntent(normalizedPrompt);
  const nameTerms = highSignalNameTerms(terms, normalizedPrompt);
  const specs: GeoapifySearchSpec[] = categories.map((category) => ({
    categories: [category],
    label: category,
  }));

  for (const term of nameTerms) {
    specs.push({
      categories,
      name: term,
      label: `${term} in ${categories.slice(0, 3).join("|")}`,
    });
  }

  return specs.length > 0
    ? specs
    : [{ categories: ["catering", "commercial"], label: "catering|commercial" }];
}

async function searchGeoapify({
  apiKey,
  filter,
  bias,
  spec,
}: {
  apiKey: string;
  filter: string;
  bias: string;
  spec: GeoapifySearchSpec;
}) {
  const params = new URLSearchParams({
    apiKey,
    categories: spec.categories.join(","),
    limit: String(RESULTS_PER_CALL),
    lang: "en",
    filter,
    bias,
  });

  if (spec.name) {
    params.set("name", spec.name);
  }

  const response = await fetch(`${GEOAPIFY_PLACES_URL}?${params}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "visit-ai-activity-discovery/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Geoapify Places failed with ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as GeoapifyFeatureCollection;
  return (data.features ?? [])
    .map((feature) => normalizeGeoapifyFeature(feature, spec))
    .filter((candidate): candidate is OSMCandidate => Boolean(candidate));
}

function normalizeGeoapifyFeature(
  feature: GeoapifyFeature,
  spec: GeoapifySearchSpec,
): OSMCandidate | null {
  const properties = feature.properties;
  const placeName = properties?.name ?? properties?.address_line1;
  const placeId = properties?.place_id;
  const categories = properties?.categories ?? [];
  const [lon, lat] = feature.geometry?.coordinates ?? [];
  const latitude = numberOrUndefined(properties?.lat) ?? numberOrUndefined(lat);
  const longitude = numberOrUndefined(properties?.lon) ?? numberOrUndefined(lon);

  if (!placeName || !placeId) {
    return null;
  }

  const primaryCategory = categories[0] ?? spec.categories[0] ?? "geoapify:place";
  const tags = uniqueStrings([
    "local business",
    ...categoryTags(categories),
    ...categories.map((category) => category.replace(/[._-]/g, " ")),
    ...(properties?.formatted ? [properties.formatted] : []),
    ...(spec.name ? [spec.name] : []),
  ]).slice(0, 28);
  const possibleActivities = possibleActivitiesForCategories(categories);

  return {
    provider: "geoapify",
    providerCategories: categories,
    formattedAddress: properties?.formatted,
    distanceMeters: numberOrUndefined(properties?.distance),
    estimatedCredits: 1,
    activityName: possibleActivities[0] ?? "visit place",
    placeName,
    osmId: placeId,
    osmType: "geoapify",
    latitude,
    longitude,
    rawTags: {
      name: placeName,
      formatted: properties?.formatted ?? "",
      address_line1: properties?.address_line1 ?? "",
      address_line2: properties?.address_line2 ?? "",
      categories: categories.join(";"),
      city: properties?.city ?? "",
      street: properties?.street ?? "",
      housenumber: properties?.housenumber ?? "",
    },
    category: `geoapify:${primaryCategory}`,
    tags,
    possibleActivities,
  };
}

function categoriesForIntent(normalizedPrompt: string) {
  const categories = new Set<string>();
  const mentionsFood = /\b(food|eat|restaurant|cafe|bakery|dessert|drink|tea|boba|bubble)\b/.test(
    normalizedPrompt,
  );

  if (/\b(bubble tea|boba|milk tea|tea)\b/.test(normalizedPrompt)) {
    categories.add("catering.cafe.bubble_tea");
    categories.add("catering.cafe.tea");
    categories.add("catering.cafe.dessert");
    categories.add("commercial.food_and_drink.coffee_and_tea");
    categories.add("commercial.food_and_drink.bakery");
  }

  if (mentionsFood) {
    categories.add("catering.cafe");
    categories.add("catering.restaurant");
    categories.add("commercial.food_and_drink");
  }

  if (/\b(croffle|bakery|bakeries|pastry|pastries|cake|dessert)\b/.test(normalizedPrompt)) {
    categories.add("commercial.food_and_drink.bakery");
    categories.add("catering.cafe.cake");
    categories.add("catering.cafe.dessert");
  }

  if (/\b(museum|gallery|culture|cultural|art)\b/.test(normalizedPrompt)) {
    categories.add("entertainment.museum");
    categories.add("entertainment.culture.gallery");
  }

  return [...categories].slice(0, 8);
}

function highSignalNameTerms(terms: string[], normalizedPrompt: string) {
  const phraseTerms = terms.filter((term) => normalizeText(term).includes(" "));
  const promptTerms = [
    /\bbubble tea\b/.test(normalizedPrompt) ? "bubble tea" : "",
    /\bboba\b/.test(normalizedPrompt) ? "boba" : "",
    /\bmilk tea\b/.test(normalizedPrompt) ? "milk tea" : "",
    /\bcroffle\b/.test(normalizedPrompt) ? "croffle" : "",
  ];

  return uniqueStrings([...phraseTerms, ...promptTerms])
    .map(normalizeText)
    .filter((term) => term.length >= 4)
    .slice(0, 4);
}

function categoryTags(categories: string[]) {
  const haystack = categories.join(" ");
  const tags = new Set<string>();

  if (haystack.includes("catering") || haystack.includes("food_and_drink")) {
    tags.add("food");
    tags.add("indoor");
    tags.add("group-friendly");
  }
  if (haystack.includes("bubble_tea")) tags.add("bubble tea");
  if (haystack.includes("tea")) tags.add("tea");
  if (haystack.includes("bakery")) tags.add("bakery");
  if (haystack.includes("dessert") || haystack.includes("cake")) tags.add("dessert");
  if (haystack.includes("coffee")) tags.add("coffee");

  return [...tags];
}

function possibleActivitiesForCategories(categories: string[]) {
  const haystack = categories.join(" ");

  if (haystack.includes("bubble_tea")) {
    return ["bubble tea stop", "food stop"];
  }
  if (haystack.includes("bakery")) {
    return ["bakery stop", "food stop"];
  }
  if (haystack.includes("dessert") || haystack.includes("cake")) {
    return ["dessert stop", "food stop"];
  }
  if (haystack.includes("catering") || haystack.includes("food_and_drink")) {
    return ["food stop"];
  }

  return ["visit place"];
}

function dedupeGeoapifyCandidates(candidates: OSMCandidate[]) {
  const byKey = new Map<string, OSMCandidate>();

  for (const candidate of candidates) {
    const key =
      candidate.osmId ||
      `${normalizeText(candidate.placeName)}:${candidate.latitude ?? ""}:${candidate.longitude ?? ""}`;
    if (!byKey.has(key)) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

function geoapifyCallLimit(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 3;
    case "deep":
      return 10;
    default:
      return 6;
  }
}

function specLabel(spec: GeoapifySearchSpec) {
  return spec.name
    ? `${spec.name} :: ${spec.categories.join(",")}`
    : spec.categories.join(",");
}

function emptyGeoapifyResult(): GeoapifyRetrievalResult {
  return {
    candidates: [],
    debug: {
      calls: 0,
      estimatedCredits: 0,
      rawCandidates: 0,
      dedupedCandidates: 0,
      queries: [],
      requestFilters: [],
      requestBiases: [],
    },
  };
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[_:/-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function numberOrUndefined(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
