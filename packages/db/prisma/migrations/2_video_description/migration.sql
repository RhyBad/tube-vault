-- AlterTable
-- CR-14: long-form video description on Video, captured at full-metadata
-- acquisition (add-url). Nullable, no default — flat channel enumeration
-- carries no description, so channel-listed candidates stay NULL until a full
-- metadata fetch. TEXT (unbounded) because descriptions are arbitrarily long.
ALTER TABLE "Video" ADD COLUMN     "description" TEXT;
