import type { ActivityDiscoveryRequest } from "./types";

const REQUIRED_QUERY_TEMPLATES = [
  "niche activities in {location} reddit",
  "best activities in {location}",
  "things to do in {location} with friends",
  "cheap activities in {location}",
  "unique things to do in {location}",
  "arcade karaoke bowling billiards activities in {location}",
];

export function buildQueryPlan(request: ActivityDiscoveryRequest) {
  const baseQueries = REQUIRED_QUERY_TEMPLATES.map((template) =>
    template.replace("{location}", request.location),
  );

  const preferenceQueries = request.preferences
    .map((preference) => preference.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((preference) => `${preference} activities in ${request.location}`);

  return uniqueStrings([...baseQueries, ...preferenceQueries]);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
