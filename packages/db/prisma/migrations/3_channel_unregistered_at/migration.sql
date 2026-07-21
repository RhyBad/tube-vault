-- AlterTable
-- CR-06: soft "unregister" for the preservation-first channel delete. NULL =
-- active (registered); a timestamp = unregistered — the archived copies stay,
-- but the JOB-07 re-enumeration scan and the live-scan due-query exclude the
-- channel so no new collection happens. Nullable, no default (existing rows are
-- active). ?purgeMedia=true is the separate hard delete (DELETE the row).
ALTER TABLE "Channel" ADD COLUMN     "unregisteredAt" TIMESTAMP(3);
