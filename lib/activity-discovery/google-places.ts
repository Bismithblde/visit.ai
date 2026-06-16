import type { BusinessSearchArea } from "./search-area";
import type {
  ActivityDiscoveryRequest,
  DiscoveryLocation,
  IntentProfile,
  OSMCandidate,
} from "./types";

const GOOGLE_PLACES_TEXT_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACES_DETAILS_URL = "https://places.googleapis.com/v1/places";
const RESULTS_PER_CALL = 20;
const GOOGLE_PLACES_MAX_PAGES = 3;
const TEXT_SEARCH_TIMEOUT_MS = 3000;
const PLACE_DETAILS_TIMEOUT_MS = 1500;
const TEXT_SEARCH_FIELD_MASK = [
  "nextPageToken",
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
].join(",");
const PLACE_DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "types",
  "primaryType",
  "primaryTypeDisplayName",
  "rating",
  "userRatingCount",
  "googleMapsUri",
  "editorialSummary",
  "reviews",
  "reviewSummary",
].join(",");

interface GooglePlacesTextSearchResponse {
  places?: GooglePlace[];
  nextPageToken?: string;
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: {
    latitude?: number;
    longitude?: number;
  };
  types?: string[];
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  editorialSummary?: { text?: string };
  reviewSummary?: { text?: string };
  reviews?: GooglePlaceReview[];
}

interface GooglePlaceReview {
  rating?: number;
  relativePublishTimeDescription?: string;
  text?: { text?: string };
  authorAttribution?: {
    displayName?: string;
    uri?: string;
  };
}

interface GooglePlacesLocationConstraint {
  filter?: {
    circle?: {
      center: { latitude: number; longitude: number };
      radius: number;
    };
    rectangle?: {
      low: { latitude: number; longitude: number };
      high: { latitude: number; longitude: number };
    };
  };
  bias?: {
    circle: {
      center: { latitude: number; longitude: number };
      radius: number;
    };
  };
}

export interface GooglePlacesRetrievalResult {
  candidates: OSMCandidate[];
  debug: {
    status: "completed" | "skipped" | "timed_out" | "failed";
    skipReason?: string;
    calls: number;
    estimatedCredits: number;
    rawCandidates: number;
    dedupedCandidates: number;
    queries: string[];
    identifiedSubjects: string[];
    rejectedCombinedQueries: string[];
    requestFilters: string[];
    requestBiases: string[];
    errors: string[];
  };
}

interface GooglePlacesSearchSpec {
  query: string;
  label: string;
}

export async function retrieveGooglePlacesCandidates({
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
}): Promise<GooglePlacesRetrievalResult> {
  if (!apiKey) {
    return emptyGooglePlacesResult("missing GOOGLE_PLACES_API_KEY");
  }

  if (!location.latitude || !location.longitude) {
    return emptyGooglePlacesResult("missing resolved latitude/longitude");
  }

  const searchPlan = buildGooglePlacesSearchSpecs(request, intent);
  const specs = searchPlan.specs.slice(
    0,
    googlePlacesCallLimit(request.searchMode),
  );

  if (specs.length === 0) {
    return {
      candidates: [],
      debug: {
        status: "skipped",
        skipReason: "no Google Places subjects or queries returned by LLM",
        calls: 0,
        estimatedCredits: 0,
        rawCandidates: 0,
        dedupedCandidates: 0,
        queries: [],
        identifiedSubjects: searchPlan.identifiedSubjects,
        rejectedCombinedQueries: searchPlan.rejectedCombinedQueries,
        requestFilters: [],
        requestBiases: [],
        errors: [],
      },
    };
  }

  const locationConstraint = googlePlacesLocationConstraint(searchArea);
  const settled = await Promise.allSettled(
    specs.map((spec) =>
      searchGooglePlaces({ apiKey, locationConstraint, spec }),
    ),
  );
  const errors = settled.flatMap((result) =>
    result.status === "fulfilled"
      ? result.value.errors
      : [errorMessage(result.reason)],
  );
  const searchCalls = settled.reduce(
    (total, result) =>
      total + (result.status === "fulfilled" ? result.value.calls : 1),
    0,
  );
  const rawCandidates = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.candidates : [],
  );
  const dedupedCandidates = dedupeGooglePlacesCandidates(rawCandidates);
  const details = await enrichGooglePlacesWithDetails({
    apiKey,
    candidates: dedupedCandidates,
    limit: googlePlacesDetailsLimit(request.searchMode),
  });
  const candidates = details.candidates;

  return {
    candidates,
    debug: {
      status: errors.length + details.errors.length > 0 ? "failed" : "completed",
      calls: searchCalls + details.calls,
      estimatedCredits: searchCalls + details.calls,
      rawCandidates: rawCandidates.length,
      dedupedCandidates: candidates.length,
      queries: specs.map((spec) => spec.label),
      identifiedSubjects: searchPlan.identifiedSubjects,
      rejectedCombinedQueries: searchPlan.rejectedCombinedQueries,
      requestFilters: specs.map(() => JSON.stringify(locationConstraint.filter)),
      requestBiases: specs.map(() => JSON.stringify(locationConstraint.bias)),
      errors: [...errors, ...details.errors],
    },
  };
}

function buildGooglePlacesSearchSpecs(
  request: ActivityDiscoveryRequest,
  intent: IntentProfile,
) {
  const plan = googlePlaceSearchSubjects(intent);

  const specs = plan.queries.map((term) => ({
    query: term,
    label: term,
  }));

  return {
    ...plan,
    specs,
  };
}

function googlePlaceSearchSubjects(intent: IntentProfile) {
  const identifiedSubjects = cleanGooglePlaceQueries(intent.googlePlaceSubjects ?? []);
  const explicitQueryCandidates = cleanGooglePlaceQueries(intent.googlePlaceQueries ?? []);
  const rejectedCombinedQueries = explicitQueryCandidates.filter((query) =>
    combinesMultipleSubjects(query, identifiedSubjects),
  );
  const explicitQueries = explicitQueryCandidates.filter(
    (query) => !rejectedCombinedQueries.includes(query),
  );

  return {
    identifiedSubjects,
    rejectedCombinedQueries,
    queries: uniqueStrings([...identifiedSubjects, ...explicitQueries]).slice(0, 10),
  };
}

function cleanGooglePlaceQueries(queries: string[]) {
  return queries
    .map((query) => normalizeQueryTerm(query))
    .filter((query) => query && isGooglePlaceQuery(query));
}

function isGooglePlaceQuery(query: string) {
  if (query.length > 80) {
    return false;
  }

  return !/\b(reddit|blog|review|reviews|best things to do|hidden gems)\b/i.test(query);
}

function combinesMultipleSubjects(query: string, subjects: string[]) {
  if (subjects.length < 2) {
    return false;
  }

  const normalizedQuery = normalizeText(query);
  return (
    subjects.filter((subject) => {
      const normalizedSubject = normalizeText(subject);
      return normalizedSubject && normalizedQuery.includes(normalizedSubject);
    }).length > 1
  );
}

function expandSearchSubjects(
  subjects: string[],
  searchMode: ActivityDiscoveryRequest["searchMode"],
) {
  if (searchMode === "fast") {
    return subjects;
  }

  const expanded: string[] = [];
  for (const subject of subjects) {
    expanded.push(subject);

    if (subject === "bubble tea") {
      expanded.push(
        "boba tea",
        "boba shop",
        "milk tea",
        "bubble tea cafe",
        "tea shop",
      );
    }
  }

  return uniqueStrings(expanded);
}

function extractSubjectTerms(value: string) {
  const text = normalizeTextForSubjectSplitting(value);
  if (!text) {
    return [];
  }

  const subjects = new Set<string>();
  let remainder = ` ${text} `;

  for (const phrase of SUBJECT_PHRASES) {
    const pattern = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "g");
    if (pattern.test(text)) {
      subjects.add(phrase);
      remainder = remainder.replace(pattern, " ");
    }
  }

  for (const chunk of remainder.split(/\s*(?:\+|,|;|\b(?:and|or|with|for|near|in|around|plus)\b)\s*/)) {
    const tokens = chunk
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => !QUERY_FILLER_WORDS.has(token));

    if (tokens.length === 0) {
      continue;
    }

    const term = normalizeQueryTerm(tokens.join(" "));
    if (isSpecificSubject(term)) {
      subjects.add(term);
    }
  }

  return [...subjects];
}

function collapseOverlappingSubjects(subjects: string[]) {
  return subjects.filter((subject) => {
    const tokens = subject.split(" ");
    if (tokens.length > 1) {
      return true;
    }

    return !subjects.some((other) => {
      if (other === subject || !other.includes(" ")) {
        return false;
      }
      return other.split(" ").includes(subject);
    });
  });
}

function isSpecificSubject(term: string) {
  if (!term || QUERY_FILLER_WORDS.has(term)) {
    return false;
  }

  const tokens = term.split(" ");
  if (tokens.some((token) => QUERY_FILLER_WORDS.has(token))) {
    return false;
  }

  if (tokens.length === 1) {
    return SINGLE_SUBJECT_WORDS.has(term);
  }

  return tokens.some((token) => SUBJECT_ANCHOR_WORDS.has(token));
}

async function searchGooglePlaces({
  apiKey,
  locationConstraint,
  spec,
}: {
  apiKey: string;
  locationConstraint: GooglePlacesLocationConstraint;
  spec: GooglePlacesSearchSpec;
}): Promise<{ candidates: OSMCandidate[]; errors: string[]; calls: number }> {
  const areaBody = locationConstraint.filter
    ? { locationRestriction: locationConstraint.filter }
    : locationConstraint.bias
      ? { locationBias: locationConstraint.bias }
      : {};
  const baseBody = {
    textQuery: spec.query,
    pageSize: RESULTS_PER_CALL,
    languageCode: "en",
    ...areaBody,
  };
  const candidates: OSMCandidate[] = [];
  const errors: string[] = [];
  let calls = 0;
  let pageToken: string | undefined;

  for (let page = 0; page < GOOGLE_PLACES_MAX_PAGES; page += 1) {
    const body = pageToken ? { ...baseBody, pageToken } : baseBody;
    calls += 1;

    let response: Response;
    try {
      response = await fetchWithTimeout(
        GOOGLE_PLACES_TEXT_SEARCH_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": TEXT_SEARCH_FIELD_MASK,
          },
          body: JSON.stringify(body),
          cache: "no-store",
        },
        TEXT_SEARCH_TIMEOUT_MS,
      );
    } catch (error) {
      errors.push(errorMessage(error));
      break;
    }

    if (!response.ok) {
      errors.push(
        await googlePlacesErrorMessage(response, "Text Search", spec.query),
      );
      break;
    }

    const data = (await response.json()) as GooglePlacesTextSearchResponse;
    candidates.push(
      ...(data.places ?? [])
        .map((place) => normalizeGooglePlace(place, spec))
        .filter((candidate): candidate is OSMCandidate => Boolean(candidate)),
    );
    pageToken = cleanText(data.nextPageToken ?? "") || undefined;

    if (!pageToken) {
      break;
    }
  }

  return {
    candidates,
    errors,
    calls,
  };
}

async function enrichGooglePlacesWithDetails({
  apiKey,
  candidates,
  limit,
}: {
  apiKey: string;
  candidates: OSMCandidate[];
  limit: number;
}) {
  const targets = candidates.slice(0, limit);
  const settled = await Promise.allSettled(
    targets.map((candidate) => fetchGooglePlaceDetails({ apiKey, candidate })),
  );
  const byId = new Map(candidates.map((candidate) => [candidate.osmId, candidate]));
  const errors: string[] = [];
  let calls = 0;

  for (const [index, result] of settled.entries()) {
    calls += 1;
    const original = targets[index];
    if (!original) {
      continue;
    }

    if (result.status === "fulfilled") {
      byId.set(original.osmId, mergeGooglePlaceDetails(original, result.value));
    } else {
      errors.push(errorMessage(result.reason));
    }
  }

  return {
    candidates: candidates.map((candidate) => byId.get(candidate.osmId) ?? candidate),
    calls,
    errors,
  };
}

async function fetchGooglePlaceDetails({
  apiKey,
  candidate,
}: {
  apiKey: string;
  candidate: OSMCandidate;
}) {
  const response = await fetchWithTimeout(
    `${GOOGLE_PLACES_DETAILS_URL}/${encodeURIComponent(candidate.osmId)}`,
    {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": PLACE_DETAILS_FIELD_MASK,
      },
      cache: "no-store",
    },
    PLACE_DETAILS_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(
      await googlePlacesErrorMessage(response, "Place Details", candidate.placeName),
    );
  }

  return (await response.json()) as GooglePlace;
}

function mergeGooglePlaceDetails(candidate: OSMCandidate, place: GooglePlace) {
  const detail = normalizeGooglePlace(place, {
    query: candidate.rawTags.query ?? candidate.placeName,
    label: candidate.rawTags.query ?? candidate.placeName,
  });

  if (!detail) {
    return candidate;
  }

  return {
    ...candidate,
    formattedAddress: detail.formattedAddress ?? candidate.formattedAddress,
    providerCategories: detail.providerCategories?.length
      ? detail.providerCategories
      : candidate.providerCategories,
    rating: detail.rating ?? candidate.rating,
    reviewCount: detail.reviewCount ?? candidate.reviewCount,
    reviewSummary: detail.reviewSummary ?? candidate.reviewSummary,
    sourceUrls: detail.sourceUrls?.length ? detail.sourceUrls : candidate.sourceUrls,
    rawTags: {
      ...candidate.rawTags,
      ...detail.rawTags,
      query: candidate.rawTags.query ?? detail.rawTags.query,
    },
    tags: uniqueStrings([...candidate.tags, ...detail.tags]).slice(0, 32),
  };
}

function normalizeGooglePlace(
  place: GooglePlace,
  spec: GooglePlacesSearchSpec,
): OSMCandidate | null {
  const placeName = place.displayName?.text;
  const placeId = place.id;

  if (!placeName || !placeId) {
    return null;
  }

  const categories = uniqueStrings([
    place.primaryType ?? "",
    place.primaryTypeDisplayName?.text ?? "",
    ...(place.types ?? []),
  ]);
  const tags = uniqueStrings([
    "local business",
    ...categoryTags(categories, spec.query),
    ...categories.map((category) => category.replace(/[._-]/g, " ")),
    spec.label,
    place.editorialSummary?.text ?? "",
  ]).slice(0, 32);
  const possibleActivities = possibleActivitiesForPlace(categories, spec.query);
  const reviewSummary = googleReviewSummary(place);

  return {
    provider: "google_places",
    providerCategories: categories,
    formattedAddress: place.formattedAddress,
    estimatedCredits: 1,
    rating: numberOrUndefined(place.rating),
    reviewCount: numberOrUndefined(place.userRatingCount),
    reviewSummary,
    sourceUrls: place.googleMapsUri ? [place.googleMapsUri] : [],
    activityName: possibleActivities[0] ?? "visit place",
    placeName,
    osmId: placeId,
    osmType: "google_places",
    latitude: numberOrUndefined(place.location?.latitude),
    longitude: numberOrUndefined(place.location?.longitude),
    rawTags: {
      name: placeName,
      formatted_address: place.formattedAddress ?? "",
      types: categories.join(";"),
      rating: String(place.rating ?? ""),
      user_rating_count: String(place.userRatingCount ?? ""),
      google_maps_uri: place.googleMapsUri ?? "",
      editorial_summary: place.editorialSummary?.text ?? "",
      google_review_summary: place.reviewSummary?.text ?? "",
      review_summary: reviewSummary ?? "",
      query: spec.query,
    },
    category: `google_places:${categories[0] ?? "place"}`,
    tags,
    possibleActivities,
  };
}

function googlePlacesLocationConstraint(
  area: BusinessSearchArea,
): GooglePlacesLocationConstraint {
  if (
    area.mode === "circle" &&
    typeof area.centerLatitude === "number" &&
    typeof area.centerLongitude === "number" &&
    typeof area.radiusMeters === "number"
  ) {
    return {
      bias: {
        circle: {
          center: {
            latitude: area.centerLatitude,
            longitude: area.centerLongitude,
          },
          radius: area.radiusMeters,
        },
      },
    };
  }

  if (area.boundingBox) {
    const [south, north, west, east] = area.boundingBox;
    return {
      filter: {
        rectangle: {
          low: { latitude: south, longitude: west },
          high: { latitude: north, longitude: east },
        },
      },
      bias: undefined,
    };
  }

  return { filter: undefined, bias: undefined };
}

function googleReviewSummary(place: GooglePlace) {
  const reviewSnippets = (place.reviews ?? [])
    .map((review) => {
      const text = cleanText(review.text?.text ?? "");
      if (!text) {
        return "";
      }
      const author = cleanText(review.authorAttribution?.displayName ?? "");
      const rating = numberOrUndefined(review.rating);
      const prefix = [
        author,
        rating !== undefined ? `${rating}/5` : "",
        review.relativePublishTimeDescription,
      ]
        .filter(Boolean)
        .join(", ");
      return prefix ? `${prefix}: ${text}` : text;
    })
    .filter(Boolean)
    .slice(0, 3);

  return uniqueStrings([
    place.editorialSummary?.text ?? "",
    place.reviewSummary?.text ?? "",
    ...reviewSnippets,
  ])
    .join(" ")
    .slice(0, 700) || undefined;
}

function categoryTags(categories: string[], query: string) {
  const haystack = normalizeText(`${categories.join(" ")} ${query}`);
  const tags = new Set<string>();

  if (/\b(food|restaurant|cafe|bakery|dessert|tea|meal|bar)\b/.test(haystack)) {
    tags.add("food");
    tags.add("indoor");
    tags.add("group-friendly");
  }
  if (/\b(bubble tea|boba|milk tea)\b/.test(haystack)) tags.add("bubble tea");
  if (/\btea\b/.test(haystack)) tags.add("tea");
  if (/\bbakery|bakeries|pastry|croffle\b/.test(haystack)) tags.add("bakery");
  if (/\bdessert|cake|sweet\b/.test(haystack)) tags.add("dessert");
  if (/\bcoffee|cafe\b/.test(haystack)) tags.add("coffee");
  if (/\bmuseum|gallery|art|culture\b/.test(haystack)) tags.add("cultural");

  return [...tags];
}

function possibleActivitiesForPlace(categories: string[], query: string) {
  const haystack = normalizeText(`${categories.join(" ")} ${query}`);

  if (/\b(bubble tea|boba|milk tea)\b/.test(haystack)) {
    return ["bubble tea stop", "food stop"];
  }
  if (/\bbakery|bakeries|pastry|croffle\b/.test(haystack)) {
    return ["bakery stop", "food stop"];
  }
  if (/\bdessert|cake|sweet\b/.test(haystack)) {
    return ["dessert stop", "food stop"];
  }
  if (/\b(food|restaurant|cafe|meal|bar)\b/.test(haystack)) {
    return ["food stop"];
  }
  if (/\bmuseum|gallery|art|culture\b/.test(haystack)) {
    return ["visit attraction"];
  }

  return ["visit place"];
}

function dedupeGooglePlacesCandidates(candidates: OSMCandidate[]) {
  const byKey = new Map<string, OSMCandidate>();

  for (const candidate of candidates) {
    const key =
      candidate.osmId ||
      `${normalizeText(candidate.placeName)}:${candidate.latitude ?? ""}:${candidate.longitude ?? ""}`;
    const existing = byKey.get(key);
    if (!existing || scoreCandidate(candidate) > scoreCandidate(existing)) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

function scoreCandidate(candidate: OSMCandidate) {
  return (candidate.rating ?? 0) + Math.min(candidate.reviewCount ?? 0, 1000) / 1000;
}

function googlePlacesCallLimit(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 3;
    case "deep":
      return 10;
    default:
      return 6;
  }
}

function googlePlacesDetailsLimit(searchMode: ActivityDiscoveryRequest["searchMode"]) {
  switch (searchMode) {
    case "fast":
      return 6;
    case "deep":
      return 16;
    default:
      return 10;
  }
}

function emptyGooglePlacesResult(skipReason: string): GooglePlacesRetrievalResult {
  return {
    candidates: [],
    debug: {
      status: "skipped",
      skipReason,
      calls: 0,
      estimatedCredits: 0,
      rawCandidates: 0,
      dedupedCandidates: 0,
      queries: [],
      identifiedSubjects: [],
      rejectedCombinedQueries: [],
      requestFilters: [],
      requestBiases: [],
      errors: [],
    },
  };
}

function normalizeQueryTerm(value: string) {
  return cleanText(value)
    .replace(/\b(near me|nearby)\b/gi, "")
    .replace(/\b(croffles)\b/gi, "croffle")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: string) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[_:/-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTextForSubjectSplitting(value: string) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[_:/-]+/g, " ")
    .replace(/[^a-z0-9 +,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function numberOrUndefined(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function googlePlacesErrorMessage(
  response: Response,
  operation: string,
  context: string,
) {
  const body = await response.text().catch(() => "");
  const compactBody = body.replace(/\s+/g, " ").trim().slice(0, 500);
  return `Google Places ${operation} failed for "${context}" with ${response.status} ${response.statusText}${compactBody ? `: ${compactBody}` : ""}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SUBJECT_PHRASES = [
  "bubble tea",
  "milk tea",
  "asian desserts",
  "asian dessert",
  "ice cream",
  "hot pot",
  "dim sum",
  "food hall",
  "night market",
  "coffee shop",
  "tea house",
  "escape room",
  "art museum",
  "history museum",
  "botanical garden",
];

const SINGLE_SUBJECT_WORDS = new Set([
  "bakery",
  "bakeries",
  "boba",
  "brunch",
  "cafe",
  "cafes",
  "coffee",
  "croffle",
  "dessert",
  "desserts",
  "food",
  "gallery",
  "karaoke",
  "market",
  "museum",
  "museums",
  "park",
  "parks",
  "ramen",
  "restaurant",
  "restaurants",
  "sushi",
  "tacos",
  "tea",
  "theater",
  "theatre",
]);

const SUBJECT_ANCHOR_WORDS = new Set([
  ...SINGLE_SUBJECT_WORDS,
  "activity",
  "activities",
  "asian",
  "bar",
  "bars",
  "food",
  "garden",
  "gardens",
  "shop",
  "shops",
  "store",
  "stores",
]);

const QUERY_FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "best",
  "cheap",
  "drink",
  "eat",
  "find",
  "friends",
  "get",
  "go",
  "going",
  "good",
  "great",
  "hidden",
  "i",
  "just",
  "like",
  "local",
  "near",
  "need",
  "only",
  "place",
  "places",
  "please",
  "random",
  "some",
  "spot",
  "spots",
  "stop",
  "the",
  "to",
  "try",
  "visit",
  "want",
  "with",
]);
