-- CR-24: repair videos mistagged contentType=REGULAR that were actually captured
-- as lives (they have a LiveSession). The live-probe promoted a PRE-EXISTING
-- enumerated (REGULAR) row to capture but never reclassified it, so an already-
-- ended live vanishes from every contentType=LIVE surface (the LIVE badge,
-- "recently ended" = videos?contentType=LIVE). The forward fix
-- (markContentTypeLive at detection + capture-start) is forward-only; this
-- one-time backfill corrects the historical rows. Idempotent: re-running matches
-- zero rows. Scoped to REGULAR (the only observed mistag) so a legitimate
-- SHORTS/PREMIERE/MEMBERS_ONLY row that happens to have a session is untouched.
UPDATE "Video" v
SET "contentType" = 'LIVE', "updatedAt" = CURRENT_TIMESTAMP
WHERE v."contentType" = 'REGULAR'
  AND EXISTS (SELECT 1 FROM "LiveSession" ls WHERE ls."videoId" = v.id);
