import { getCacheClient } from "@/lib/redis";
import { buildRequestCacheKey } from "./normalize";
import { parseActivityInput, parsePreferences } from "./preferences";
import { qualityCheck, rankActivities, toResponseItem } from "./ranking";
import { candidatesToRecords, getActivityStore, type ActivityStore } from "./store";
import { runTavilyFallback } from "./tavily";
import type { ActivityResponse } from "./types";

const REQUEST_CACHE_TTL_SECONDS = 60 * 10;

export async function discoverRankedActivities(
  input: unknown,
  deps?: {
    store?: ActivityStore;
    cache?: ReturnType<typeof getCacheClient>;
  },
) {
  const parsedInput = parseActivityInput(input);

  if (!parsedInput.ok) {
    return { ok: false as const, error: parsedInput.error };
  }

  const request = parsedInput.request;
  const parsedPreferences = parsePreferences(request);
  const cacheKey = buildRequestCacheKey(request, parsedPreferences);
  const cache = deps?.cache ?? getCacheClient();
  const cached = await cache.get<ActivityResponse>(cacheKey);

  if (cached) {
    return {
      ok: true as const,
      response: {
        ...cached,
        source: "cache" as const,
      },
    };
  }

  const store = deps?.store ?? getActivityStore();
  const dbActivities = await store.findActivities(request);
  let dbCoverage = qualityCheck(dbActivities, parsedPreferences);
  let tavilyQueries: string[] = [];
  let finalActivities = dbActivities;
  let source: ActivityResponse["source"] = "database";

  if (!dbCoverage.isEnough) {
    try {
      const tavily = await runTavilyFallback(request, parsedPreferences, {
        async getCached<T>(key: string) {
          return cache.get<T>(key);
        },
        async setCached<T>(key: string, value: T, ttlSeconds: number) {
          await cache.set(key, value, { ex: ttlSeconds });
        },
        async saveSearchResult(result) {
          await store.saveSearchResults(result);
        },
      });
      tavilyQueries = tavily.queries;
      await store.upsertCandidates(tavily.candidates);
      await store.updateCityCoverage(request);

      const candidateRecords = candidatesToRecords(tavily.candidates);
      finalActivities = mergeActivityRecords(dbActivities, candidateRecords);
      dbCoverage = qualityCheck(finalActivities, parsedPreferences);
      source = dbActivities.length > 0 ? "database+tavily" : "tavily";
    } catch {
      source = dbActivities.length > 0 ? "database" : "empty";
      finalActivities = dbActivities;
    }
  }

  const ranked = rankActivities(finalActivities, parsedPreferences, request.budget);
  const activities = ranked
    .slice(0, 24)
    .map((item) => toResponseItem(item.activity, item.score, item.reason));
  const response: ActivityResponse = {
    activities,
    source: activities.length > 0 ? source : "empty",
    debug: {
      cacheKey,
      parsedPreferences,
      dbCoverage,
      tavilyQueries,
    },
  };

  if (activities.length > 0) {
    await cache.set(cacheKey, response, { ex: REQUEST_CACHE_TTL_SECONDS });
  }

  return { ok: true as const, response };
}

function mergeActivityRecords(primary: Awaited<ReturnType<ActivityStore["findActivities"]>>, incoming: Awaited<ReturnType<ActivityStore["findActivities"]>>) {
  const byKey = new Map<string, (typeof primary)[number]>();

  for (const activity of [...primary, ...incoming]) {
    const key = `${activity.city}:${activity.normalizedName}`;
    const existing = byKey.get(key);
    if (!existing || activity.confidenceScore > existing.confidenceScore) {
      byKey.set(key, activity);
    }
  }

  return [...byKey.values()];
}
