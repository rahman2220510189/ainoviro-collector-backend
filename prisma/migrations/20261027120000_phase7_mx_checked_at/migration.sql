-- Step 7.4: remember when an email's mail server was last rechecked, so answers that
-- said "no mail server" are confirmed again (some were DNS errors on the host).
ALTER TABLE "emails" ADD COLUMN "mx_checked_at" TIMESTAMPTZ(3);
CREATE INDEX "emails_mx_recheck_idx" ON "emails" ("mx_valid", "mx_checked_at");
