-- Phase 4.6: staging table for Foursquare OS Places (Hugging Face release).

-- CreateTable
CREATE TABLE "stg_fsq_places" (
    "id" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "release" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "category_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category_labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "website" TEXT,
    "tel" TEXT,
    "email" TEXT,
    "address" TEXT,
    "locality" TEXT,
    "region" TEXT,
    "postcode" TEXT,
    "facebook_id" TEXT,
    "instagram" TEXT,
    "twitter" TEXT,
    "date_created" TEXT,
    "date_refreshed" TEXT,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stg_fsq_places_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stg_fsq_places_country_code_idx" ON "stg_fsq_places"("country_code");
