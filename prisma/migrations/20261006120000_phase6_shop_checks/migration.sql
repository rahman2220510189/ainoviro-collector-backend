-- Phase 6.3: does the business already sell online? One row per website domain.

-- CreateTable
CREATE TABLE "domain_shop_checks" (
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sells_online" BOOLEAN,
    "signals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_error" TEXT,
    "checked_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_shop_checks_pkey" PRIMARY KEY ("domain")
);

-- CreateIndex
CREATE INDEX "domain_shop_checks_sells_online_idx" ON "domain_shop_checks"("sells_online");
