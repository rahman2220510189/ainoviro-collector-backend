-- Phase 4.1: staging table for Overture Maps places and a log of dataset imports.

-- CreateTable
CREATE TABLE "stg_overture_places" (
    "id" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "release" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "basic_category" TEXT,
    "taxonomy_primary" TEXT,
    "taxonomy_hierarchy" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "taxonomy_alternates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION,
    "operating_status" TEXT,
    "websites" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "socials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "brand_name" TEXT,
    "address" TEXT,
    "locality" TEXT,
    "postcode" TEXT,
    "region" TEXT,
    "datasets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stg_overture_places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_imports" (
    "id" SERIAL NOT NULL,
    "source" "source_name" NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "release" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "dataset_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stg_overture_places_country_code_idx" ON "stg_overture_places"("country_code");

-- CreateIndex
CREATE INDEX "stg_overture_places_taxonomy_primary_idx" ON "stg_overture_places"("taxonomy_primary");

-- CreateIndex
CREATE INDEX "dataset_imports_source_country_code_idx" ON "dataset_imports"("source", "country_code");
