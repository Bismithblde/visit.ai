CREATE TABLE "Location" (
  "id" TEXT NOT NULL,
  "canonicalName" TEXT NOT NULL,
  "normalizedKey" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "region" TEXT,
  "country" TEXT,
  "aliases" JSONB,
  "parentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Location_normalizedKey_key" ON "Location"("normalizedKey");
CREATE INDEX "Location_parentId_idx" ON "Location"("parentId");
CREATE INDEX "Location_city_region_country_idx" ON "Location"("city", "region", "country");

ALTER TABLE "Location"
  ADD CONSTRAINT "Location_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Location"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Activity"
  ADD COLUMN "locationId" TEXT,
  ADD COLUMN "indoorOutdoor" TEXT,
  ADD COLUMN "minGroupSize" INTEGER,
  ADD COLUMN "maxGroupSize" INTEGER,
  ADD COLUMN "needsFallbackVerification" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Activity_locationId_idx" ON "Activity"("locationId");

ALTER TABLE "Activity"
  ADD CONSTRAINT "Activity_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SearchRun" (
  "id" TEXT NOT NULL,
  "locationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "normalizedQuery" TEXT NOT NULL,
  "url" TEXT,
  "normalizedUrl" TEXT,
  "title" TEXT,
  "contentHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "metadata" JSONB,
  "fetchedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SearchRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SearchRun_locationKey_idx" ON "SearchRun"("locationKey");
CREATE INDEX "SearchRun_requestHash_idx" ON "SearchRun"("requestHash");
CREATE INDEX "SearchRun_normalizedQuery_idx" ON "SearchRun"("normalizedQuery");
CREATE INDEX "SearchRun_normalizedUrl_idx" ON "SearchRun"("normalizedUrl");
CREATE INDEX "SearchRun_contentHash_idx" ON "SearchRun"("contentHash");
