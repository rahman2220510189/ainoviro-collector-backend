-- Step 7.5: hourly counts per country, so the dashboard can tell when leads stop
-- becoming ready or a review reason suddenly grows (a silent problem becomes a warning).
CREATE TABLE "health_snapshots" (
  "id" SERIAL PRIMARY KEY,
  "country_code" CHAR(2) NOT NULL,
  "taken_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "ready" INTEGER NOT NULL,
  "needs_review" INTEGER NOT NULL,
  "reasons" JSONB NOT NULL DEFAULT '{}',
  "emails_total" INTEGER NOT NULL,
  "exported_total" INTEGER NOT NULL
);
CREATE INDEX "health_snapshots_country_taken_idx" ON "health_snapshots" ("country_code", "taken_at");
