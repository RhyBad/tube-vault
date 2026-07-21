-- AlterEnum
-- CR-20: a finished live capture whose completeness can't be measured yet (the
-- VOD is still processing, or the probe couldn't reach was_live + duration)
-- parks in AWAITING_VERIFY; an archive-role re-check sweep re-probes and resolves
-- it to VERIFYING (complete -> verify in place -> HEALTHY), PARTIAL_KEPT (short,
-- or the conservative deadline fallback), or FAILED. Additive, no data change.
-- ADD VALUE without USE-in-same-tx is permitted on PG12+ (we only add here).
ALTER TYPE "CopyState" ADD VALUE 'AWAITING_VERIFY';
