-- CreateEnum
CREATE TYPE "location_type" AS ENUM ('COUNTRY', 'REGION', 'CITY');

-- CreateEnum
CREATE TYPE "lead_type" AS ENUM ('VENDOR', 'USER');

-- CreateEnum
CREATE TYPE "source_name" AS ENUM ('GOOGLE_PLACES', 'OVERTURE', 'FOURSQUARE');

-- CreateEnum
CREATE TYPE "business_status" AS ENUM ('OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "place_status" AS ENUM ('NEW', 'EXPORTED', 'CONTACTED', 'REPLIED', 'ONBOARDED', 'PRODUCT_ADDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "email_type" AS ENUM ('GENERIC', 'PERSONAL');

-- CreateEnum
CREATE TYPE "email_status" AS ENUM ('NEW', 'EXPORTED', 'BOUNCED', 'UNSUBSCRIBED', 'REJECTED');

-- CreateEnum
CREATE TYPE "lawful_basis" AS ENUM ('LEGITIMATE_INTEREST_B2B', 'CONSENT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "suppression_reason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'EXISTING_CONTACT', 'EXISTING_VENDOR', 'MANUAL', 'ERASED');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED_USER', 'PAUSED_QUOTA', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "task_kind" AS ENUM ('DISCOVERY', 'CRAWL', 'CLEAN');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEFERRED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "event_level" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "crawl_status" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "export_batch_status" AS ENUM ('ACTIVE', 'UNDONE');

-- CreateTable
CREATE TABLE "admin_users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_login_at" TIMESTAMPTZ(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "actor_id" INTEGER,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcategories" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subcategories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcategory_keywords" (
    "id" SERIAL NOT NULL,
    "subcategory_id" INTEGER NOT NULL,
    "language" VARCHAR(8) NOT NULL,
    "keyword" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcategory_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_category_map" (
    "id" SERIAL NOT NULL,
    "source" "source_name" NOT NULL,
    "source_category" TEXT NOT NULL,
    "subcategory_id" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_category_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "type" "location_type" NOT NULL,
    "name" TEXT NOT NULL,
    "name_local" TEXT,
    "country_code" CHAR(2) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "bbox_south" DOUBLE PRECISION,
    "bbox_west" DOUBLE PRECISION,
    "bbox_north" DOUBLE PRECISION,
    "bbox_east" DOUBLE PRECISION,
    "population" INTEGER,
    "geonames_id" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "places" (
    "id" SERIAL NOT NULL,
    "lead_type" "lead_type" NOT NULL DEFAULT 'VENDOR',
    "name" TEXT NOT NULL,
    "name_normalized" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "city_id" INTEGER,
    "city_name" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "website" TEXT,
    "website_domain" TEXT,
    "phone_raw" TEXT,
    "phone_e164" TEXT,
    "phone_valid" BOOLEAN NOT NULL DEFAULT false,
    "google_place_id" TEXT,
    "overture_id" TEXT,
    "fsq_id" TEXT,
    "google_fetched_at" TIMESTAMPTZ(3),
    "business_status" "business_status" NOT NULL DEFAULT 'UNKNOWN',
    "rating" DOUBLE PRECISION,
    "rating_count" INTEGER,
    "is_chain" BOOLEAN NOT NULL DEFAULT false,
    "score" INTEGER NOT NULL DEFAULT 0,
    "status" "place_status" NOT NULL DEFAULT 'NEW',
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_crawled_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "place_sources" (
    "id" SERIAL NOT NULL,
    "place_id" INTEGER NOT NULL,
    "source" "source_name" NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "place_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "place_subcategories" (
    "place_id" INTEGER NOT NULL,
    "subcategory_id" INTEGER NOT NULL,
    "matched_keyword" TEXT,
    "source" "source_name" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "place_subcategories_pkey" PRIMARY KEY ("place_id","subcategory_id")
);

-- CreateTable
CREATE TABLE "emails" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "place_id" INTEGER,
    "lead_type" "lead_type" NOT NULL DEFAULT 'VENDOR',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "email_type" "email_type" NOT NULL,
    "is_own_domain" BOOLEAN NOT NULL DEFAULT false,
    "syntax_valid" BOOLEAN NOT NULL DEFAULT false,
    "mx_valid" BOOLEAN,
    "is_disposable" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "source_url" TEXT,
    "seen_count" INTEGER NOT NULL DEFAULT 1,
    "lawful_basis" "lawful_basis" NOT NULL DEFAULT 'UNKNOWN',
    "status" "email_status" NOT NULL DEFAULT 'NEW',
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exported_at" TIMESTAMPTZ(3),
    "export_batch_id" INTEGER,
    "bounced_at" TIMESTAMPTZ(3),
    "unsubscribed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression" (
    "id" SERIAL NOT NULL,
    "email_hash" CHAR(64),
    "email_normalized" TEXT,
    "domain" TEXT,
    "reason" "suppression_reason" NOT NULL,
    "source_file" TEXT,
    "note" TEXT,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "free_email_domains" (
    "domain" TEXT NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_email_domains_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "chain_blocklist" (
    "id" SERIAL NOT NULL,
    "name_normalized" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "domain" TEXT,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_blocklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_crawls" (
    "domain" TEXT NOT NULL,
    "status" "crawl_status" NOT NULL DEFAULT 'PENDING',
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "emails_found" INTEGER NOT NULL DEFAULT 0,
    "robots_blocked" BOOLEAN NOT NULL DEFAULT false,
    "used_playwright" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "crawled_at" TIMESTAMPTZ(3),
    "next_retry_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "domain_crawls_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "lead_type" "lead_type" NOT NULL DEFAULT 'VENDOR',
    "status" "job_status" NOT NULL DEFAULT 'QUEUED',
    "source_plan" "source_name"[],
    "options" JSONB NOT NULL DEFAULT '{}',
    "estimate" JSONB,
    "extra_budget_eur" DECIMAL(10,2),
    "paid_requests_used" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_locations" (
    "job_id" INTEGER NOT NULL,
    "location_id" INTEGER NOT NULL,

    CONSTRAINT "job_locations_pkey" PRIMARY KEY ("job_id","location_id")
);

-- CreateTable
CREATE TABLE "job_subcategories" (
    "job_id" INTEGER NOT NULL,
    "subcategory_id" INTEGER NOT NULL,

    CONSTRAINT "job_subcategories_pkey" PRIMARY KEY ("job_id","subcategory_id")
);

-- CreateTable
CREATE TABLE "job_tasks" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "kind" "task_kind" NOT NULL,
    "task_key" TEXT NOT NULL,
    "source" "source_name",
    "location_id" INTEGER,
    "subcategory_id" INTEGER,
    "keyword" TEXT,
    "language" VARCHAR(8),
    "page" INTEGER,
    "tile" JSONB,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "parent_task_id" INTEGER,
    "domain" TEXT,
    "place_id" INTEGER,
    "status" "task_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "results_count" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "job_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "level" "event_level" NOT NULL DEFAULT 'INFO',
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "query_log" (
    "id" SERIAL NOT NULL,
    "source" "source_name" NOT NULL,
    "location_id" INTEGER,
    "tile_key" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "language" VARCHAR(8) NOT NULL,
    "last_run_at" TIMESTAMPTZ(3) NOT NULL,
    "results" INTEGER NOT NULL DEFAULT 0,
    "pages" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "query_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_batches" (
    "id" SERIAL NOT NULL,
    "profile" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "row_count" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "status" "export_batch_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMPTZ(3),

    CONSTRAINT "export_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_batch_items" (
    "batch_id" INTEGER NOT NULL,
    "email_id" INTEGER NOT NULL,
    "place_id" INTEGER NOT NULL,
    "row_number" INTEGER NOT NULL,

    CONSTRAINT "export_batch_items_pkey" PRIMARY KEY ("batch_id","email_id")
);

-- CreateTable
CREATE TABLE "api_usage" (
    "provider" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "period" CHAR(7) NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "paid_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_usage_pkey" PRIMARY KEY ("provider","sku","period")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "subcategories_category_id_slug_key" ON "subcategories"("category_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "subcategory_keywords_subcategory_id_language_keyword_key" ON "subcategory_keywords"("subcategory_id", "language", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "source_category_map_source_source_category_subcategory_id_key" ON "source_category_map"("source", "source_category", "subcategory_id");

-- CreateIndex
CREATE UNIQUE INDEX "locations_geonames_id_key" ON "locations"("geonames_id");

-- CreateIndex
CREATE INDEX "locations_parent_id_idx" ON "locations"("parent_id");

-- CreateIndex
CREATE INDEX "locations_country_code_type_idx" ON "locations"("country_code", "type");

-- CreateIndex
CREATE UNIQUE INDEX "places_google_place_id_key" ON "places"("google_place_id");

-- CreateIndex
CREATE UNIQUE INDEX "places_overture_id_key" ON "places"("overture_id");

-- CreateIndex
CREATE UNIQUE INDEX "places_fsq_id_key" ON "places"("fsq_id");

-- CreateIndex
CREATE INDEX "places_website_domain_idx" ON "places"("website_domain");

-- CreateIndex
CREATE INDEX "places_phone_e164_idx" ON "places"("phone_e164");

-- CreateIndex
CREATE INDEX "places_city_id_idx" ON "places"("city_id");

-- CreateIndex
CREATE INDEX "places_status_idx" ON "places"("status");

-- CreateIndex
CREATE INDEX "places_needs_review_idx" ON "places"("needs_review");

-- CreateIndex
CREATE INDEX "places_country_code_name_normalized_idx" ON "places"("country_code", "name_normalized");

-- CreateIndex
CREATE INDEX "place_sources_place_id_idx" ON "place_sources"("place_id");

-- CreateIndex
CREATE UNIQUE INDEX "place_sources_source_source_record_id_key" ON "place_sources"("source", "source_record_id");

-- CreateIndex
CREATE INDEX "place_subcategories_subcategory_id_idx" ON "place_subcategories"("subcategory_id");

-- CreateIndex
CREATE UNIQUE INDEX "place_subcategories_one_primary_per_place" ON "place_subcategories"("place_id", "is_primary") WHERE ("is_primary" = true);

-- CreateIndex
CREATE UNIQUE INDEX "emails_email_normalized_key" ON "emails"("email_normalized");

-- CreateIndex
CREATE INDEX "emails_domain_idx" ON "emails"("domain");

-- CreateIndex
CREATE INDEX "emails_place_id_idx" ON "emails"("place_id");

-- CreateIndex
CREATE INDEX "emails_status_idx" ON "emails"("status");

-- CreateIndex
CREATE INDEX "emails_exported_at_idx" ON "emails"("exported_at");

-- CreateIndex
CREATE UNIQUE INDEX "emails_one_primary_per_place" ON "emails"("place_id", "is_primary") WHERE ("is_primary" = true);

-- CreateIndex
CREATE UNIQUE INDEX "suppression_email_hash_key" ON "suppression"("email_hash");

-- CreateIndex
CREATE INDEX "suppression_domain_idx" ON "suppression"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "chain_blocklist_name_normalized_key" ON "chain_blocklist"("name_normalized");

-- CreateIndex
CREATE INDEX "domain_crawls_status_next_retry_at_idx" ON "domain_crawls"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_created_at_idx" ON "jobs"("created_at");

-- CreateIndex
CREATE INDEX "job_locations_location_id_idx" ON "job_locations"("location_id");

-- CreateIndex
CREATE INDEX "job_subcategories_subcategory_id_idx" ON "job_subcategories"("subcategory_id");

-- CreateIndex
CREATE INDEX "job_tasks_job_id_status_idx" ON "job_tasks"("job_id", "status");

-- CreateIndex
CREATE INDEX "job_tasks_job_id_kind_status_idx" ON "job_tasks"("job_id", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_tasks_job_id_task_key_key" ON "job_tasks"("job_id", "task_key");

-- CreateIndex
CREATE INDEX "job_events_job_id_created_at_idx" ON "job_events"("job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "query_log_source_tile_key_keyword_language_key" ON "query_log"("source", "tile_key", "keyword", "language");

-- CreateIndex
CREATE INDEX "export_batches_created_at_idx" ON "export_batches"("created_at");

-- CreateIndex
CREATE INDEX "export_batch_items_email_id_idx" ON "export_batch_items"("email_id");

-- CreateIndex
CREATE INDEX "export_batch_items_place_id_idx" ON "export_batch_items"("place_id");

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcategory_keywords" ADD CONSTRAINT "subcategory_keywords_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "subcategories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_category_map" ADD CONSTRAINT "source_category_map_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "subcategories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "places" ADD CONSTRAINT "places_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_sources" ADD CONSTRAINT "place_sources_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_subcategories" ADD CONSTRAINT "place_subcategories_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_subcategories" ADD CONSTRAINT "place_subcategories_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "subcategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_export_batch_id_fkey" FOREIGN KEY ("export_batch_id") REFERENCES "export_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_locations" ADD CONSTRAINT "job_locations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_locations" ADD CONSTRAINT "job_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_subcategories" ADD CONSTRAINT "job_subcategories_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_subcategories" ADD CONSTRAINT "job_subcategories_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "subcategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_tasks" ADD CONSTRAINT "job_tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_tasks" ADD CONSTRAINT "job_tasks_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_tasks" ADD CONSTRAINT "job_tasks_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "subcategories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_tasks" ADD CONSTRAINT "job_tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "job_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_tasks" ADD CONSTRAINT "job_tasks_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "query_log" ADD CONSTRAINT "query_log_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_batches" ADD CONSTRAINT "export_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_batch_items" ADD CONSTRAINT "export_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "export_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_batch_items" ADD CONSTRAINT "export_batch_items_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_batch_items" ADD CONSTRAINT "export_batch_items_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Custom CHECK constraints (not expressible in schema.prisma).
-- Prisma Migrate does not manage CHECK constraints, so later migrations keep them.
-- =============================================================================

-- ---- emails: the duplicate guarantee ---------------------------------------
-- email_normalized must already be trimmed + lowercase and look like an address.
-- Together with the UNIQUE index this makes "Info@Shop.cy" and "info@shop.cy"
-- impossible to store twice.
ALTER TABLE "emails" ADD CONSTRAINT "emails_email_normalized_chk"
  CHECK (
    email_normalized = lower(btrim(email_normalized))
    AND email_normalized LIKE '_%@_%.__%'
  );

-- domain must be lowercase and equal to the part after "@".
ALTER TABLE "emails" ADD CONSTRAINT "emails_domain_chk"
  CHECK (domain = lower(domain) AND split_part(email_normalized, '@', 2) = domain);

ALTER TABLE "emails" ADD CONSTRAINT "emails_seen_count_chk"
  CHECK (seen_count >= 1);

-- ---- suppression -------------------------------------------------------------
-- Every row blocks either one email (by hash) or a whole domain.
ALTER TABLE "suppression" ADD CONSTRAINT "suppression_target_chk"
  CHECK (email_hash IS NOT NULL OR domain IS NOT NULL);

-- Hash must be a lowercase SHA-256 hex string.
ALTER TABLE "suppression" ADD CONSTRAINT "suppression_email_hash_chk"
  CHECK (email_hash IS NULL OR email_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "suppression" ADD CONSTRAINT "suppression_email_normalized_chk"
  CHECK (email_normalized IS NULL OR email_normalized = lower(btrim(email_normalized)));

ALTER TABLE "suppression" ADD CONSTRAINT "suppression_domain_chk"
  CHECK (domain IS NULL OR domain = lower(domain));

-- ---- places ------------------------------------------------------------------
ALTER TABLE "places" ADD CONSTRAINT "places_phone_e164_chk"
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$');

ALTER TABLE "places" ADD CONSTRAINT "places_website_domain_chk"
  CHECK (website_domain IS NULL OR website_domain = lower(website_domain));

ALTER TABLE "places" ADD CONSTRAINT "places_rating_chk"
  CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5));

-- ---- lookup lists ------------------------------------------------------------
ALTER TABLE "free_email_domains" ADD CONSTRAINT "free_email_domains_lowercase_chk"
  CHECK (domain = lower(btrim(domain)));

-- ---- quota guard -------------------------------------------------------------
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_counts_chk"
  CHECK (request_count >= 0 AND paid_count >= 0);

ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_period_chk"
  CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- ---- jobs --------------------------------------------------------------------
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_extra_budget_chk"
  CHECK (extra_budget_eur IS NULL OR extra_budget_eur >= 0);
