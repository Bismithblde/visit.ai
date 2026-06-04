export type ActivityTagName =
  | "food"
  | "outdoor"
  | "museum"
  | "nightlife"
  | "shopping"
  | "scenic"
  | "free"
  | "cheap"
  | "mid_price"
  | "expensive"
  | "local_favorite"
  | "hidden_gem"
  | "touristy"
  | "romantic"
  | "family_friendly"
  | "rainy_day"
  | "walking"
  | "short_visit"
  | "unique"
  | "seasonal";

export type ActivitySourceKind =
  | "reddit"
  | "local_blog"
  | "tourism"
  | "official"
  | "review_site"
  | "listicle"
  | "other";

export interface ActivityRequest {
  city: string;
  region?: string;
  country?: string;
  dates?: string[];
  groupSize?: number;
  budget?: "low" | "medium" | "high" | "unknown";
  preferences: string;
  balancePreferences: string[];
}

export interface ParsedPreference {
  tagWeights: Partial<Record<ActivityTagName, number>>;
  importantTags: ActivityTagName[];
  unmatchedTerms: string[];
}

export interface ActivityRecord {
  id: string;
  name: string;
  normalizedName: string;
  city: string;
  region: string | null;
  country: string | null;
  description: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  priceLevel: string | null;
  confidenceScore: number;
  createdAt: Date;
  updatedAt: Date;
  lastVerifiedAt: Date | null;
  tags: Array<{
    tag: string;
    weight: number;
    confidence: number;
  }>;
  sources: Array<{
    sourceType: string;
    url: string;
    title: string | null;
    snippet: string | null;
    queryUsed: string | null;
    confidence: number;
    createdAt: Date;
  }>;
}

export interface ActivityResponseItem {
  id: string;
  name: string;
  description: string;
  tags: ActivityTagName[];
  sourceConfidence: number;
  sourceUrls: string[];
  evidence: Array<{
    url: string;
    title?: string;
    snippet?: string;
    sourceType: string;
  }>;
  location?: {
    address?: string;
    latitude?: number;
    longitude?: number;
  };
  priceEstimate?: string;
  recommendationReason: string;
  score: number;
}

export interface ActivityResponse {
  activities: ActivityResponseItem[];
  source: "cache" | "database" | "database+tavily" | "tavily" | "empty";
  debug: {
    cacheKey: string;
    parsedPreferences: ParsedPreference;
    dbCoverage: QualityCheck;
    tavilyQueries: string[];
  };
}

export interface QualityCheck {
  isEnough: boolean;
  totalActivities: number;
  matchingImportantTags: number;
  averageConfidence: number;
  evidenceCoverage: number;
  reasons: string[];
}

export interface SearchCandidate {
  name: string;
  normalizedName: string;
  city: string;
  region?: string;
  country?: string;
  description: string;
  tags: ActivityTagName[];
  source: {
    sourceType: ActivitySourceKind;
    url: string;
    title: string;
    snippet: string;
    queryUsed: string;
    confidence: number;
  };
  priceLevel?: string;
  confidenceScore: number;
}
