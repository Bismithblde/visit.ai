import type { SourceType } from "./types";

const LOCAL_BLOG_HOST_HINTS = [
  "timeout",
  "eater",
  "thrillist",
  "secret",
  "untapped",
  "ny.eater",
  "gothamist",
  "theinfatuation",
  "local",
  "blog",
];

const TRAVEL_HOST_HINTS = [
  "tripadvisor",
  "lonelyplanet",
  "atlasobscura",
  "timeout",
  "nyctourism",
  "iloveny",
  "travel",
];

const EVENT_HOST_HINTS = [
  "eventbrite",
  "meetup",
  "donyc",
  "nycgo",
  "fever",
  "bucketlisters",
  "calendar",
];

const REVIEW_HOST_HINTS = ["yelp", "tripadvisor", "google", "foursquare"];

export function getSourceType(url: string): SourceType {
  const hostname = safeHostname(url);
  const pathname = safePathname(url);
  const haystack = `${hostname} ${pathname}`.toLowerCase();

  if (hostname.includes("reddit.com")) {
    return "reddit";
  }

  if (EVENT_HOST_HINTS.some((hint) => haystack.includes(hint))) {
    return "event_page";
  }

  if (REVIEW_HOST_HINTS.some((hint) => haystack.includes(hint))) {
    return "review_site";
  }

  if (
    pathname.includes("best") ||
    pathname.includes("things-to-do") ||
    pathname.includes("guide") ||
    pathname.includes("list")
  ) {
    return "listicle";
  }

  if (LOCAL_BLOG_HOST_HINTS.some((hint) => haystack.includes(hint))) {
    return "local_blog";
  }

  if (TRAVEL_HOST_HINTS.some((hint) => haystack.includes(hint))) {
    return "travel_site";
  }

  return "other";
}

export function sourceQualityScore(url: string) {
  switch (getSourceType(url)) {
    case "reddit":
      return 1;
    case "local_blog":
      return 0.92;
    case "event_page":
      return 0.86;
    case "travel_site":
      return 0.78;
    case "review_site":
      return 0.76;
    case "listicle":
      return 0.72;
    default:
      return 0.45;
  }
}

export function sortUrlsBySourceQuality(urls: string[]) {
  return [...urls].sort(
    (a, b) => sourceQualityScore(b) - sourceQualityScore(a),
  );
}

function safeHostname(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function safePathname(url: string) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}
