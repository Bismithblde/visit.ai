export interface ActivityDateRange {
  start?: string;
  end?: string;
}

export interface ActivityDiscoveryRequest {
  cityOrLocation: string;
  groupSize: number;
  dateRange?: ActivityDateRange;
  preferencePrompt: string;
  searchMode: "fast" | "balanced" | "deep";
}

export type DiscoverySource =
  | "geoapify"
  | "osm"
  | "reddit"
  | "web"
  | "geoapify+reddit"
  | "geoapify+web"
  | "osm+reddit"
  | "osm+web"
  | "mixed";

export interface DiscoveryLocation {
  query: string;
  latitude?: number;
  longitude?: number;
  boundingBox?: [number, number, number, number];
}

export interface ActivityDiscoveryItem {
  activityName: string;
  placeName?: string;
  location?: {
    label?: string;
    latitude?: number;
    longitude?: number;
  };
  source: DiscoverySource;
  sourceUrls: string[];
  osm?: {
    id: string;
    type: string;
    tags: Record<string, string>;
    category: string;
  };
  provider?: {
    name: "osm" | "geoapify";
    id: string;
    categories?: string[];
    formattedAddress?: string;
    distanceMeters?: number;
    estimatedCredits?: number;
  };
  tags: string[];
  confidenceScore: number;
  preferenceMatchScore: number;
  rating?: number;
  reviewCount?: number;
  verificationSources?: string[];
  reviewSummary?: string;
  evidenceSummary: string;
  reason: string;
  fitsPreference: boolean;
  missingInfo: string[];
  possibleConcerns: string[];
}

export interface DiscoveryDebug {
  searchedQueries: string[];
  reviewQueries: string[];
  visitedUrls: string[];
  failedUrls: string[];
  timedOutStages: string[];
  intentProfile?: IntentProfile;
  sourceCounts: {
    geoapify: number;
    geoapifyCalls: number;
    geoapifyEstimatedCredits: number;
    geoapifyDeduped: number;
    geoapifyEvidenceVerified: number;
    osm: number;
    intentFiltered: number;
    reviewVerified: number;
    reddit: number;
    web: number;
    merged: number;
    returned: number;
  };
}

export interface DiscoveryResponse {
  location: DiscoveryLocation;
  queryPlan: string[];
  activities: ActivityDiscoveryItem[];
  debug: DiscoveryDebug;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface PageContent {
  url: string;
  title?: string;
  content: string;
  sourceType: SourceType;
  score?: number;
}

export type SourceType =
  | "reddit"
  | "local_blog"
  | "travel_site"
  | "event_page"
  | "review_site"
  | "listicle"
  | "other";

export interface DiscoveryTool {
  web_search(query: string, maxResults: number): Promise<SearchResult[]>;
  extract_page(url: string): Promise<PageContent>;
  crawl_page(url: string, maxDepth: number): Promise<PageContent[]>;
}

export interface DiscoveryToolDebug {
  visitedUrls: string[];
  failedUrls: string[];
}

export interface OSMCandidate {
  provider?: "osm" | "geoapify";
  providerCategories?: string[];
  formattedAddress?: string;
  distanceMeters?: number;
  estimatedCredits?: number;
  activityName: string;
  placeName: string;
  osmId: string;
  osmType: string;
  latitude?: number;
  longitude?: number;
  rawTags: Record<string, string>;
  category: string;
  tags: string[];
  possibleActivities: string[];
}

export interface IntentConcept {
  term: string;
  weight: number;
  type: "must" | "should" | "avoid";
}

export interface IntentProfile {
  primaryGoal: string;
  concepts: IntentConcept[];
  placeTypes: string[];
  activityTypes: string[];
  attributes: string[];
  exclusions: string[];
  reviewSearchTerms: string[];
  minimumPreferenceScore: number;
  searchAreaKind: "neighborhood" | "city" | "metro" | "region" | "unknown";
  recommendedRadiusMeters: number;
  radiusReason: string;
}

export interface SocialCandidate {
  activityName: string;
  placeName?: string;
  sourceUrl: string;
  sourceType: SourceType;
  tags: string[];
  sentiment: "positive" | "mixed" | "negative" | "unknown";
  evidenceSummary: string;
  confidenceScore: number;
  preferenceRelevanceScore: number;
}
