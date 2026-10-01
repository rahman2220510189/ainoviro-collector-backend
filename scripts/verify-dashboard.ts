/**
 * Checks against the REAL database that the dashboard numbers (step 3.5) agree with
 * each other and with the export. Read only: nothing is written or changed.
 *
 * Usage: npm run dashboard:verify
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { createExportService } from '../src/export/export-service';
import { ACTIVITY_DAYS, createDashboardService } from '../src/services/dashboard-service';

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 12 });
  try {
    const started = Date.now();
    const d = await createDashboardService(db).summary('CY');
    const ms = Date.now() - started;
    const preview = await createExportService(db).preview({ country: 'CY' });

    check(
      'A. "Ready to download" is the same number the Leads page button shows',
      d.leads.ready === preview.newRows && d.leads.needsReview === preview.needsReview,
      `dashboard ${d.leads.ready} / ${d.leads.needsReview} review, export ${preview.newRows} / ${preview.needsReview} review`,
    );

    check(
      'B. Businesses: ready <= with email <= all found',
      d.leads.ready <= d.leads.withEmail && d.leads.withEmail <= d.leads.totalPlaces,
      `${d.leads.ready} ready, ${d.leads.withEmail} with email, ${d.leads.totalPlaces} found`,
    );

    const statusSum = sum(Object.values(d.leads.byStatus));
    check(
      'C. Status counts add up to the businesses with email',
      statusSum === d.leads.withEmail,
      `${JSON.stringify(d.leads.byStatus)} = ${statusSum}`,
    );

    check(
      'D. Emails: generic + personal = all, exported <= all',
      d.emails.generic + d.emails.personal === d.emails.total &&
        d.emails.exported <= d.emails.total,
      `${d.emails.generic} + ${d.emails.personal} = ${d.emails.total}, exported ${d.emails.exported}`,
    );

    const w = d.websites;
    check(
      'E. Websites: found / none / failed / robots fit inside the crawled ones',
      w.emailFound + w.noEmailFound + w.failed <= w.crawled + w.robotsBlocked &&
        w.crawled <= w.withWebsite,
      `${w.crawled} crawled of ${w.withWebsite}: ${w.emailFound} with email, ${w.noEmailFound} none, ${w.failed} failed, ${w.robotsBlocked} robots, ${w.waiting} waiting`,
    );

    check(
      'F. Top cities and categories never count more than the businesses with email',
      sum(d.topCities.map((c) => c.withEmail)) <= d.leads.withEmail &&
        sum(d.topCategories.map((c) => c.withEmail)) <= d.leads.withEmail,
      `top city: ${d.topCities[0]?.name ?? '-'} (${d.topCities[0]?.withEmail ?? 0}), top category: ${d.topCategories[0]?.name ?? '-'} (${d.topCategories[0]?.withEmail ?? 0})`,
    );

    const last = d.activity[d.activity.length - 1];
    check(
      `G. Activity has ${ACTIVITY_DAYS} days ending today (Cyprus time)`,
      d.activity.length === ACTIVITY_DAYS &&
        last?.date ===
          new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Nicosia' }).format(new Date()),
      `${d.activity[0]?.date} .. ${last?.date}, ${sum(d.activity.map((a) => a.newEmails))} new emails`,
    );

    check(
      'H. Google history and exports read; the page loads quickly',
      d.google.months.every((m) => m.paid <= m.requests) && d.exports.rows >= 0 && ms < 15_000,
      `${d.google.months.map((m) => `${m.period}: ${m.requests}`).join(', ') || 'no real requests yet'}; ${d.exports.batches} batches, ${d.exports.rows} rows; ${ms} ms`,
    );
  } finally {
    await db.end();
  }
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
