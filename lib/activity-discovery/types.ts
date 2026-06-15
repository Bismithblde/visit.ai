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
  debugProviders?: Partial<DiscoveryProviderToggles>;
}

export interface DiscoveryProviderToggles {
  tavily: boolean;
  googlePlaces: boolean;
  osm: boolean;
}

export type DiscoverySource =
  | "google_places"
  | "osm"
  | "reddit"
  | "web"
  | "google_places+reddit"
  | "google_places+web"
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
    name: "osm" | "google_places";
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
  stageErrors?: string[];
  intentProfile?: IntentProfile;
  sourceCounts: {
    googlePlaces: number;
    googlePlacesCalls: number;
    googlePlacesEstimatedCredits: number;
    googlePlacesDeduped: number;
    googlePlacesEvidenceVerified: number;
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
  provider?: "osm" | "google_places";
  providerCategories?: string[];
  formattedAddress?: string;
  distanceMeters?: number;
  estimatedCredits?: number;
  rating?: number;
  reviewCount?: number;
  reviewSummary?: string;
  sourceUrls?: string[];
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
  googlePlaceSubjects: string[];
  googlePlaceQueries: string[];
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
