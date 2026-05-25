export type ActivityBudget = "low" | "medium" | "high" | "unknown";
export type ActivityGroupFit =
  | "solo"
  | "couple"
  | "small_group"
  | "large_group"
  | "unknown";

export type ActivityCandidateType =
  | "place"
  | "area"
  | "event"
  | "activity_type"
  | "route";

export interface ActivityDiscoveryRequest {
  location: string;
  groupSize: number;
  budget: ActivityBudget;
  preferences: string[];
  searchMode: "fast" | "balanced" | "deep";
}

export interface ActivityCandidate {
  name: string;
  type: ActivityCandidateType;
  description: string;
  locationHint: string;
  budgetFit: ActivityBudget;
  groupFit: ActivityGroupFit;
  tags: string[];
  sourceUrls: string[];
  evidenceSnippets: string[];
  confidence: number;
  needsVerification: true;
}

export interface ActivityCluster {
  id: string;
  title: string;
  theme: string;
  description: string;
  candidateNames: string[];
  tags: string[];
  sourceUrls: string[];
  confidence: number;
  needsVerification: true;
}

export interface DiscoveryDebug {
  searchedQueries: string[];
  visitedUrls: string[];
  failedUrls: string[];
}

export interface DiscoveryResponse {
  location: string;
  queryPlan: string[];
  candidates: ActivityCandidate[];
  clusters: ActivityCluster[];
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
