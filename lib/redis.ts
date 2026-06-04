import { Redis } from "@upstash/redis";

export interface CacheClient {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ex?: number }): Promise<void>;
}

class NoopCache implements CacheClient {
  async get<T>(): Promise<T | null> {
    return null;
  }

  async set(): Promise<void> {
    return;
  }
}

let redis: Redis | null = null;
const noopCache = new NoopCache();

export function getCacheClient(): CacheClient {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return noopCache;
  }

  if (!redis) {
    redis = new Redis({ url, token });
  }

  return {
    async get<T>(key: string) {
      return redis!.get<T>(key);
    },
    async set<T>(key: string, value: T, options?: { ex?: number }) {
      if (typeof options?.ex === "number") {
        await redis!.set(key, value, { ex: options.ex });
        return;
      }

      await redis!.set(key, value);
    },
  };
}
