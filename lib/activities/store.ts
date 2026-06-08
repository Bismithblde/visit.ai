import { getPrisma } from "@/lib/prisma";
import { getSourceType } from "@/lib/activity-discovery/source-quality";
import { ACTIVITY_TAG_SET } from "./constants";
import { normalizeActivityName, normalizePlace } from "./normalize";
import type { ActivityRecord, ActivityRequest, SearchCandidate } from "./types";

export interface ActivityStore {
  findActivities(request: ActivityRequest): Promise<ActivityRecord[]>;
  saveSearchResults(input: {
    query: string;
    normalizedQueryKey: string;
    city: string;
    results: unknown;
    expiresAt: Date;
  }): Promise<void>;
  upsertCandidates(candidates: SearchCandidate[]): Promise<void>;
  updateCityCoverage(request: ActivityRequest): Promise<void>;
}

class NoopActivityStore implements ActivityStore {
  async findActivities(): Promise<ActivityRecord[]> {
    return [];
  }

  async saveSearchResults(): Promise<void> {
    return;
  }

  async upsertCandidates(): Promise<void> {
    return;
  }

  async updateCityCoverage(): Promise<void> {
    return;
  }
}

class PrismaActivityStore implements ActivityStore {
  async findActivities(request: ActivityRequest): Promise<ActivityRecord[]> {
    const prisma = getPrisma();
    return prisma.activity.findMany({
      where: {
        city: normalizePlace(request.city),
        ...(request.region ? { region: normalizePlace(request.region) } : {}),
        ...(request.country ? { country: normalizePlace(request.country) } : {}),
      },
      include: {
        tags: true,
        sources: true,
      },
      orderBy: [{ confidenceScore: "desc" }, { updatedAt: "desc" }],
      take: 60,
    });
  }

  async saveSearchResults(input: {
    query: string;
    normalizedQueryKey: string;
    city: string;
    results: unknown;
    expiresAt: Date;
  }) {
    const prisma = getPrisma();
    await prisma.searchResult.upsert({
      where: { normalizedQueryKey: input.normalizedQueryKey },
      update: {
        resultJson: input.results as object,
        expiresAt: input.expiresAt,
      },
      create: {
        query: input.query,
        normalizedQueryKey: input.normalizedQueryKey,
        city: normalizePlace(input.city),
        resultJson: input.results as object,
        expiresAt: input.expiresAt,
      },
    });
  }

  async upsertCandidates(candidates: SearchCandidate[]) {
    const prisma = getPrisma();

    for (const candidate of candidates) {
      const existing = await prisma.activity.findFirst({
        where: {
          normalizedName: candidate.normalizedName,
          city: normalizePlace(candidate.city),
          ...(candidate.region ? { region: normalizePlace(candidate.region) } : {}),
          ...(candidate.country ? { country: normalizePlace(candidate.country) } : {}),
        },
        include: { tags: true, sources: true },
      });

      const activity =
        existing ??
        (await prisma.activity.create({
          data: {
            name: candidate.name,
            normalizedName: candidate.normalizedName,
            city: normalizePlace(candidate.city),
            region: candidate.region ? normalizePlace(candidate.region) : undefined,
            country: candidate.country ? normalizePlace(candidate.country) : undefined,
            description: candidate.description,
            address: candidate.address ?? candidate.locationHint,
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            priceLevel: candidate.priceLevel,
            indoorOutdoor: candidate.indoorOutdoor,
            minGroupSize: candidate.minGroupSize,
            maxGroupSize: candidate.maxGroupSize,
            confidenceScore: candidate.confidenceScore,
            needsFallbackVerification: candidate.needsFallbackVerification ?? false,
            lastVerifiedAt: new Date(),
          },
        }));

      if (existing) {
        await prisma.activity.update({
          where: { id: existing.id },
          data: {
            description: longerText(existing.description, candidate.description),
            address: existing.address ?? candidate.address ?? candidate.locationHint,
            latitude: existing.latitude ?? candidate.latitude,
            longitude: existing.longitude ?? candidate.longitude,
            priceLevel: existing.priceLevel ?? candidate.priceLevel,
            indoorOutdoor: existing.indoorOutdoor ?? candidate.indoorOutdoor,
            minGroupSize: minDefined(existing.minGroupSize, candidate.minGroupSize),
            maxGroupSize: maxDefined(existing.maxGroupSize, candidate.maxGroupSize),
            confidenceScore: Math.max(existing.confidenceScore, candidate.confidenceScore),
            needsFallbackVerification:
              existing.needsFallbackVerification && (candidate.needsFallbackVerification ?? false),
            lastVerifiedAt: new Date(),
          },
        });
      }

      for (const tag of candidate.tags.filter((tag) => ACTIVITY_TAG_SET.has(tag))) {
        await prisma.activityTag.upsert({
          where: { activityId_tag: { activityId: activity.id, tag } },
          update: { confidence: 0.7, weight: 1 },
          create: {
            activityId: activity.id,
            tag,
            confidence: 0.7,
            weight: 1,
          },
        });
      }

      await prisma.activitySource.upsert({
        where: { activityId_url: { activityId: activity.id, url: candidate.source.url } },
        update: {
          title: candidate.source.title,
          snippet: candidate.source.snippet,
          queryUsed: candidate.source.queryUsed,
          confidence: candidate.source.confidence,
          sourceType: candidate.source.sourceType,
        },
        create: {
          activityId: activity.id,
          sourceType: candidate.source.sourceType,
          url: candidate.source.url,
          title: candidate.source.title,
          snippet: candidate.source.snippet,
          queryUsed: candidate.source.queryUsed,
          confidence: candidate.source.confidence,
        },
      });
    }
  }

  async updateCityCoverage(request: ActivityRequest) {
    const prisma = getPrisma();
    const city = normalizePlace(request.city);
    const region = request.region ? normalizePlace(request.region) : undefined;
    const country = request.country ? normalizePlace(request.country) : undefined;
    const activities = await prisma.activity.findMany({
      where: { city, ...(region ? { region } : {}), ...(country ? { country } : {}) },
      include: { tags: true, sources: true },
      take: 500,
    });
    const activityCount = activities.length;
    const foodCount = activities.filter((activity) =>
      activity.tags.some((tag) => tag.tag === "food"),
    ).length;
    const freeCount = activities.filter((activity) =>
      activity.tags.some((tag) => tag.tag === "free"),
    ).length;
    const redditSourceCount = activities.filter((activity) =>
      activity.sources.some((source) => getSourceType(source.url) === "reddit"),
    ).length;
    const coverageScore = Math.min(
      1,
      activityCount / 30 + foodCount / 60 + redditSourceCount / 40,
    );

    await prisma.cityCoverage.upsert({
      where: {
        city_region_country: {
          city,
          region: region ?? "",
          country: country ?? "",
        },
      },
      update: {
        activityCount,
        foodCount,
        freeCount,
        redditSourceCount,
        coverageScore,
        lastIndexedAt: new Date(),
      },
      create: {
        city,
        region: region ?? "",
        country: country ?? "",
        activityCount,
        foodCount,
        freeCount,
        redditSourceCount,
        coverageScore,
        lastIndexedAt: new Date(),
      },
    });
  }
}

export function getActivityStore(): ActivityStore {
  if (!process.env.DATABASE_URL) {
    return new NoopActivityStore();
  }

  return new PrismaActivityStore();
}

export function candidatesToRecords(candidates: SearchCandidate[]): ActivityRecord[] {
  const now = new Date();
  return candidates.map((candidate, index) => ({
    id: `candidate-${index}-${candidate.normalizedName}`,
    name: candidate.name,
    normalizedName: normalizeActivityName(candidate.name, candidate.city),
    city: normalizePlace(candidate.city),
    region: candidate.region ? normalizePlace(candidate.region) : null,
    country: candidate.country ? normalizePlace(candidate.country) : null,
    description: candidate.description,
    latitude: null,
    longitude: null,
    address: null,
    priceLevel: candidate.priceLevel ?? null,
    indoorOutdoor: candidate.indoorOutdoor ?? null,
    minGroupSize: candidate.minGroupSize ?? null,
    maxGroupSize: candidate.maxGroupSize ?? null,
    confidenceScore: candidate.confidenceScore,
    needsFallbackVerification: candidate.needsFallbackVerification ?? false,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
    tags: candidate.tags.map((tag) => ({ tag, weight: 1, confidence: 0.7 })),
    sources: [
      {
        sourceType: candidate.source.sourceType,
        url: candidate.source.url,
        title: candidate.source.title,
        snippet: candidate.source.snippet,
        queryUsed: candidate.source.queryUsed,
        confidence: candidate.source.confidence,
        createdAt: now,
      },
    ],
  }));
}

function longerText(a: string, b: string) {
  return a.length >= b.length ? a : b;
}

function minDefined(a: number | null | undefined, b: number | null | undefined) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function maxDefined(a: number | null | undefined, b: number | null | undefined) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}
