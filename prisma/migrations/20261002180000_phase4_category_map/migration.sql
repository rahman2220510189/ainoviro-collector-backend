-- Phase 4.3: one rule per dataset category; a rule maps to a subcategory OR excludes the category.

-- DropIndex
DROP INDEX IF EXISTS "source_category_map_source_source_category_subcategory_id_key";

-- AlterTable
ALTER TABLE "source_category_map" ALTER COLUMN "subcategory_id" DROP NOT NULL,
ADD COLUMN "excluded_reason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "source_category_map_source_source_category_key" ON "source_category_map"("source", "source_category");

-- A rule either maps or excludes, never both, never neither.
ALTER TABLE "source_category_map" ADD CONSTRAINT "source_category_map_maps_or_excludes"
  CHECK ((subcategory_id IS NULL) <> (excluded_reason IS NULL));
