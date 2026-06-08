import { getPrisma } from "@/lib/prisma";
import { getSourceType } from "@/lib/activity-discovery/source-quality";
import { ACTIVITY_TAG_SET } from "@/lib/activities/constants";
import { normalizePlace } from "@/lib/activities/normalize";
import type { ActivityRecord, SearchCandidate } from "@/lib/activities/types";
import type { NormalizedLocation } from "@/lib/activities/location";

export interface SearchRunInput {
  locationKey: string;
  requestHash: string;
  query: string;
  normalizedQuery: string;
  url?: string;
  normalizedUrl?: string;
  title?: string;
  contentHash?: string;
  status: string;
  metadata?: unknown;
  fetchedAt?: Date;
}

export async function ensureLocationHierarchy(location: NormalizedLocation) {
  const prisma = getPrisma();
  let parentId: string | undefined;

  for (const parent of [...location.parents].reverse()) {
    const row = await prisma.location.upsert({
      where: { normalizedKey: parent.normalizedKey },
      update: {
        canonicalName: parent.canonicalName,
        city: normalizePlace(parent.city),
        region: parent.region ? normalizePlace(parent.region) : null,
        country: parent.country ? normalizePlace(parent.country) : null,
        parentId,
      },
      create: {
        canonicalName: parent.canonicalName,
        normalizedKey: parent.normalizedKey,
        city: normalizePlace(parent.city),
        region: parent.region ? normalizePlace(parent.region) : null,
        country: parent.country ? normalizePlace(parent.country) : null,
        parentId,
      },
    });
    parentId = row.id;
  }

  return prisma.location.upsert({
    where: { normalizedKey: location.normalizedKey },
    update: {
      canonicalName: location.canonicalName,
      city: normalizePlace(location.city),
      region: location.region ? normalizePlace(location.region) : null,
      country: location.country ? normalizePlace(location.country) : null,
      aliases: location.aliases,
      parentId,
    },
    create: {
      canonicalName: location.canonicalName,
      normalizedKey: location.normalizedKey,
      city: normalizePlace(location.city),
      region: location.region ? normalizePlace(location.region) : null,
      country: location.country ? normalizePlace(location.country) : null,
      aliases: location.aliases,
      parentId,
    },
  });
}

export async function findInventory(location: NormalizedLocation, includeParents: boolean) {
  const prisma = getPrisma();
  const locationKeys = includeParents
    ? [location.normalizedKey, ...location.parents.map((parent) => parent.normalizedKey)]
    : [location.normalizedKey];
  const locations = await prisma.location.findMany({
    where: { normalizedKey: { in: locationKeys } },
  });
  const locationIds = locations.map((item) => item.id);
  const placeFilters = [location, ...(includeParents ? location.parents : [])].map((item) => ({
    city: normalizePlace(item.city),
    ...(item.region ? { region: normalizePlace(item.region) } : {}),
    ...(item.country ? { country: normalizePlace(item.country) } : {}),
  }));

  return prisma.activity.findMany({
    where: {
      OR: [
        ...(locationIds.length > 0 ? [{ locationId: { in: locationIds } }] : []),
        ...placeFilters,
      ],
    },
    include: { tags: true, sources: true },
    orderBy: [{ confidenceScore: "desc" }, { updatedAt: "desc" }],
    take: includeParents ? 120 : 80,
  }) as Promise<ActivityRecord[]>;
}

export async function upsertVerifiedCandidates(
  location: NormalizedLocation,
  candidates: SearchCandidate[],
) {
  const prisma = getPrisma();
  const locationRow = await ensureLocationHierarchy(location);

  for (const candidate of candidates) {
    const existing = await prisma.activity.findFirst({
      where: {
        normalizedName: candidate.normalizedName,
        locationId: locationRow.id,
      },
      include: { tags: true, sources: true },
    });

    const activity =
      existing ??
      (await prisma.activity.create({
        data: {
          name: candidate.name,
          normalizedName: candidate.normalizedName,
          locationId: locationRow.id,
          city: normalizePlace(candidate.city),
          region: candidate.region ? normalizePlace(candidate.region) : null,
          country: candidate.country ? normalizePlace(candidate.country) : null,
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
        update: { confidence: 0.75, weight: 1 },
        create: {
          activityId: activity.id,
          tag,
          confidence: 0.75,
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
        sourceType: candidate.source.sourceType || getSourceType(candidate.source.url),
      },
      create: {
        activityId: activity.id,
        sourceType: candidate.source.sourceType || getSourceType(candidate.source.url),
        url: candidate.source.url,
        title: candidate.source.title,
        snippet: candidate.source.snippet,
        queryUsed: candidate.source.queryUsed,
        confidence: candidate.source.confidence,
      },
    });
  }
}

export async function saveSearchRun(input: SearchRunInput) {
  const prisma = getPrisma();
  await prisma.searchRun.create({
    data: {
      locationKey: input.locationKey,
      requestHash: input.requestHash,
      query: input.query,
      normalizedQuery: input.normalizedQuery,
      url: input.url,
      normalizedUrl: input.normalizedUrl,
      title: input.title,
      contentHash: input.contentHash,
      status: input.status,
      metadata: input.metadata as object,
      fetchedAt: input.fetchedAt,
    },
  });
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
