-- AlterEnum
-- CR-09: a new durable job type for periodic source-availability re-checks.
-- ADD VALUE without USE-in-same-tx is permitted on PG12+ (we only add here).
ALTER TYPE "JobType" ADD VALUE 'SOURCE_CHECK';

-- AlterTable
-- Source re-check cadence cursor + false-positive streak gate on held copies.
ALTER TABLE "Video" ADD COLUMN     "lastSourceCheckAt" TIMESTAMP(3),
ADD COLUMN     "nextSourceCheckAt" TIMESTAMP(3),
ADD COLUMN     "sourceGoneStreak" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Video_nextSourceCheckAt_idx" ON "Video"("nextSourceCheckAt");
