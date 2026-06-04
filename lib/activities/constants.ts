import type { ActivityTagName } from "./types";

export const ACTIVITY_TAGS: ActivityTagName[] = [
  "food",
  "outdoor",
  "museum",
  "nightlife",
  "shopping",
  "scenic",
  "free",
  "cheap",
  "mid_price",
  "expensive",
  "local_favorite",
  "hidden_gem",
  "touristy",
  "romantic",
  "family_friendly",
  "rainy_day",
  "walking",
  "short_visit",
  "unique",
  "seasonal",
];

export const ACTIVITY_TAG_SET = new Set(ACTIVITY_TAGS);
