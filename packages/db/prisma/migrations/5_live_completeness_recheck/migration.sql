-- AlterEnum
-- CR-20: a capture whose completeness can't be measured yet settles its session
-- to ENDED_PENDING — OUT of the active set (the ux_live_session_active partial
-- unique is WHERE state IN ('DETECTED','CAPTURING')), so re-detection isn't
-- blocked and GET /api/live-sessions (active-only) hides it. The re-check sweep
-- re-settles it to ENDED_NORMAL / ENDED_INTERRUPTED on resolution.
-- ADD VALUE without USE-in-same-tx is permitted on PG12+ (we only add here).
ALTER TYPE "LiveSessionState" ADD VALUE 'ENDED_PENDING';

-- AlterTable
-- CR-20 completeness re-check cadence for a video parked in AWAITING_VERIFY.
-- nextCompletenessCheckAt = the archive-role sweep's due-cursor; completenessDeadlineAt
-- = the ~24h give-up point (then the conservative PARTIAL_KEPT fallback). Both
-- nullable, no default — set at park, cleared on resolution.
ALTER TABLE "Video" ADD COLUMN     "nextCompletenessCheckAt" TIMESTAMP(3),
ADD COLUMN     "completenessDeadlineAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Video_nextCompletenessCheckAt_idx" ON "Video"("nextCompletenessCheckAt");
