/**
 * What the crawler has achieved so far: hit rate, why websites gave no email,
 * and (with --emails) the addresses found. Read-only.
 *
 *   npm run crawl:report
 *   npm run crawl:report -- --emails [--limit 50]
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';


/**
 * Only websites that are still some place's own website. A domain that was crawled and
 * later reclassified (e.g. "as.me" became a booking platform) no longer counts.
 */
const CURRENT_CRAWLS = `(SELECT d.* FROM domain_crawls d
  WHERE EXISTS (SELECT 1 FROM places p WHERE p.website_domain = d.domain)) dc`;

const pct = (part: number, whole: number): string =>
  whole === 0 ? '-' : `${Math.round((part / whole) * 100)}%`;

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      emails: { type: 'boolean', default: false },
      limit: { type: 'string', default: '30' },
    },
  });
  const limit = Math.min(Math.max(Number(values.limit) || 30, 1), 500);
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 1 });

  try {
    const crawls = await db.query<{ status: string; with_email: boolean; n: string }>(
      `SELECT status, emails_found > 0 AS with_email, count(*) AS n
       FROM ${CURRENT_CRAWLS} GROUP BY 1, 2`,
    );
    const count = (status: string, withEmail?: boolean): number =>
      crawls.rows
        .filter(
          (r) => r.status === status && (withEmail === undefined || r.with_email === withEmail),
        )
        .reduce((sum, r) => sum + Number(r.n), 0);
    const done = count('DONE');
    const withEmail = count('DONE', true);
    const total = crawls.rows.reduce((sum, r) => sum + Number(r.n), 0);

    console.log('\nWebsites');
    console.log(`  Crawled:              ${total}`);
    console.log(`  Read successfully:    ${done}`);
    console.log(`    with email:         ${withEmail} (${pct(withEmail, done)} of those read)`);
    console.log(`    no email found:     ${done - withEmail}`);
    console.log(`  robots.txt said no:   ${count('SKIPPED')}`);
    console.log(`  Failed:               ${count('FAILED')}`);
    console.log(`  Running now:          ${count('RUNNING')}`);
    const old = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM domain_crawls d
       WHERE NOT EXISTS (SELECT 1 FROM places p WHERE p.website_domain = d.domain)`,
    );
    if (Number(old.rows[0]?.n ?? 0) > 0)
      console.log(
        `  (not counted: ${old.rows[0]?.n} no longer an own website, e.g. booking pages)`,
      );
    const errors = await db.query<{ code: string; n: string }>(
      `SELECT split_part(last_error, ':', 1) AS code, count(*) AS n
       FROM ${CURRENT_CRAWLS} WHERE status = 'FAILED' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    );
    if (errors.rows.length > 0) {
      console.log(
        `  Failure reasons:      ${errors.rows.map((r) => `${r.code} ${r.n}`).join(', ')}`,
      );
    }

    const stats = await db.query<Record<string, string>>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE is_primary) AS primary_count,
              count(*) FILTER (WHERE is_own_domain) AS own,
              count(*) FILTER (WHERE email_type = 'PERSONAL') AS personal,
              count(*) FILTER (WHERE mx_valid IS FALSE) AS no_mx,
              count(*) FILTER (WHERE is_disposable) AS disposable
       FROM emails`,
    );
    const s = stats.rows[0] ?? {};
    const emailTotal = Number(s.total ?? 0);
    const sources = await db.query<{ source: string; n: string }>(
      'SELECT source, count(*) AS n FROM emails GROUP BY 1 ORDER BY 2 DESC',
    );
    console.log('\nEmails');
    console.log(`  Stored:               ${emailTotal} (primary: ${s.primary_count ?? 0})`);
    console.log(`  Own domain:           ${s.own ?? 0} (${pct(Number(s.own ?? 0), emailTotal)})`);
    console.log(
      `  Personal / generic:   ${s.personal ?? 0} / ${emailTotal - Number(s.personal ?? 0)}`,
    );
    console.log(`  No mail server (MX):  ${s.no_mx ?? 0}`);
    console.log(`  Disposable:           ${s.disposable ?? 0}`);
    console.log(
      `  Found via:            ${sources.rows.map((r) => `${r.source} ${r.n}`).join(', ') || '-'}`,
    );

    const misses = await db.query<{ domain: string; pages_fetched: number; crawled_at: Date }>(
      `SELECT domain, pages_fetched, crawled_at FROM ${CURRENT_CRAWLS}
       WHERE status = 'DONE' AND emails_found = 0 ORDER BY crawled_at DESC LIMIT $1`,
      [limit],
    );
    if (misses.rows.length > 0) {
      console.log(`\nWebsites read but no email found (latest ${misses.rows.length}):`);
      for (const m of misses.rows) console.log(`  - ${m.domain} (${m.pages_fetched} page(s))`);
    }

    if (values.emails) {
      const rows = await db.query<{
        email_normalized: string;
        name: string;
        is_primary: boolean;
        source: string;
      }>(
        `SELECT e.email_normalized, p.name, e.is_primary, e.source
         FROM emails e LEFT JOIN places p ON p.id = e.place_id
         ORDER BY e.id DESC LIMIT $1`,
        [limit],
      );
      console.log(`\nLatest ${rows.rows.length} emails:`);
      for (const r of rows.rows) {
        console.log(
          `  ${r.is_primary ? '*' : ' '} ${r.email_normalized.padEnd(38)} ${r.name ?? '-'}  (${r.source})`,
        );
      }
      console.log('  (* = primary email of the business)');
    }
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Report failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});