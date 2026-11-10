-- Step 7.6: claimable ainoviro pages (Marketplace Plan).
-- business_pages: what the ainoviro platform reports back (page published, claimed, removed).
-- page_removals: "remove my page" requests; a removed business never gets a page again, even
-- if its place is re-created by a later data merge (matched by id, Overture id, phone, domain).
CREATE TYPE "page_status" AS ENUM ('PUBLISHED', 'CLAIMED', 'REMOVED');

CREATE TABLE "business_pages" (
  "place_id" INTEGER PRIMARY KEY REFERENCES "places"("id") ON DELETE CASCADE,
  "status" "page_status" NOT NULL,
  "page_url" TEXT,
  "claimed_at" TIMESTAMPTZ(3),
  "note" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "business_pages_status_idx" ON "business_pages" ("status");

CREATE TABLE "page_removals" (
  "id" SERIAL PRIMARY KEY,
  "place_id" INTEGER REFERENCES "places"("id") ON DELETE SET NULL,
  "overture_id" TEXT,
  "phone_e164" TEXT,
  "website_domain" TEXT,
  "name" TEXT,
  "reason" TEXT,
  "requested_via" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "page_removals_place_idx" ON "page_removals" ("place_id");
CREATE INDEX "page_removals_overture_idx" ON "page_removals" ("overture_id");
CREATE INDEX "page_removals_phone_idx" ON "page_removals" ("phone_e164");
CREATE INDEX "page_removals_domain_idx" ON "page_removals" ("website_domain");
