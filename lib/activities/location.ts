import { cleanWhitespace, normalizePlace } from "./normalize";

export interface NormalizedLocation {
  canonicalName: string;
  normalizedKey: string;
  city: string;
  region?: string;
  country?: string;
  aliases: string[];
  parents: Array<{
    canonicalName: string;
    normalizedKey: string;
    city: string;
    region?: string;
    country?: string;
  }>;
}

const LOCATION_ALIASES: Record<string, Omit<NormalizedLocation, "aliases">> = {
  flushing: {
    canonicalName: "Flushing, Queens, NY",
    normalizedKey: "flushing-queens-ny",
    city: "Flushing",
    region: "NY",
    country: "US",
    parents: [
      parent("Queens, NY", "Queens", "NY", "US"),
      parent("New York City, NY", "New York City", "NY", "US"),
      parent("New York State", "New York State", "NY", "US"),
    ],
  },
  "flushing queens ny": {
    canonicalName: "Flushing, Queens, NY",
    normalizedKey: "flushing-queens-ny",
    city: "Flushing",
    region: "NY",
    country: "US",
    parents: [
      parent("Queens, NY", "Queens", "NY", "US"),
      parent("New York City, NY", "New York City", "NY", "US"),
      parent("New York State", "New York State", "NY", "US"),
    ],
  },
  queens: {
    canonicalName: "Queens, NY",
    normalizedKey: "queens-ny",
    city: "Queens",
    region: "NY",
    country: "US",
    parents: [
      parent("New York City, NY", "New York City", "NY", "US"),
      parent("New York State", "New York State", "NY", "US"),
    ],
  },
  "college point": {
    canonicalName: "College Point, Queens, NY",
    normalizedKey: "college-point-queens-ny",
    city: "College Point",
    region: "NY",
    country: "US",
    parents: [
      parent("Queens, NY", "Queens", "NY", "US"),
      parent("New York City, NY", "New York City", "NY", "US"),
      parent("New York State", "New York State", "NY", "US"),
    ],
  },
};

export function normalizeLocation(input: string): NormalizedLocation {
  const clean = cleanLocation(input);
  const aliasKey = normalizeAlias(clean);
  const match = LOCATION_ALIASES[aliasKey];

  if (match) {
    return {
      ...match,
      aliases: Object.entries(LOCATION_ALIASES)
        .filter(([, value]) => value.normalizedKey === match.normalizedKey)
        .map(([alias]) => alias),
    };
  }

  const city = titleCase(clean.split(",")[0] || clean);
  const region = clean.split(",")[1]?.trim().toUpperCase();
  const country = clean.split(",")[2]?.trim().toUpperCase();

  return {
    canonicalName: [city, region, country].filter(Boolean).join(", "),
    normalizedKey: slug([city, region, country].filter(Boolean).join(" ")),
    city,
    region,
    country,
    aliases: [aliasKey],
    parents: [],
  };
}

export function toActivityRequestLocation(location: NormalizedLocation) {
  return {
    city: location.city,
    region: location.region,
    country: location.country,
  };
}

export function locationCacheKey(location: NormalizedLocation) {
  return `location:${location.normalizedKey}:activities`;
}

export function normalizeLocationCandidate(value: string) {
  return normalizePlace(cleanLocation(value));
}

function cleanLocation(input: string) {
  return cleanWhitespace(input).replace(/\s*,\s*/g, ", ");
}

function normalizeAlias(input: string) {
  return input
    .toLowerCase()
    .replace(/\bnew york city\b/g, "nyc")
    .replace(/\bnew york\b/g, "ny")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parent(canonicalName: string, city: string, region?: string, country?: string) {
  return {
    canonicalName,
    normalizedKey: slug(canonicalName),
    city,
    region,
    country,
  };
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
