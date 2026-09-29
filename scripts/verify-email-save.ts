/**
 * Proves against the REAL database that saving crawl results can never store the
 * same email twice, respects the suppression list, keeps exactly one primary email
 * per place, and that a re-crawl adds only NEW emails. No website is contacted.
 * Everything it creates is deleted at the end (test domain "verify-ainoviro.test").
 *
 * Usage: npm run crawl:verify
 */
import { Pool } from 'pg';
import type { SiteCrawlResult } from '../src/crawler/crawl-site';
import { EnvValidationError, loadEnv } from '../src/config/env';
import type { EvaluatedEmail } from '../src/enrich/evaluate';
import { saveCrawlResult, type SaveCrawlResult } from '../src/enrich/save';
import { hashEmail } from '../src/lib/email';

const DOMAIN = 'verify-ainoviro.test';

const CRAWL_DONE: SiteCrawlResult = {
  outcome: 'DONE',
  pages: [{ url: `https://${DOMAIN}/`, kind: 'HOME', html: '' }],
  requests: 2,
  finalOrigin: `https://${DOMAIN}`,
  robotsStatus: 'OK',
  looksJavaScriptRendered: false,
  error: null,
  pageErrors: [],
};

function email(
  local: string,
  type: 'GENERIC' | 'PERSONAL',
  original = `${local}@${DOMAIN}`,
): EvaluatedEmail {
  return {
    original,
    normalized: `${local}@${DOMAIN}`,
    domain: DOMAIN,
    source: 'mailto',
    sourceUrl: `https://${DOMAIN}/contact`,
    emailType: type,
    isOwnDomain: true,
    isFreeMail: false,
    isDisposable: false,
    mxValid: true,
    isPrimary: false,
  };
}

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}
const show = (r: SaveCrawlResult): string =>
  `new ${r.inserted}, known ${r.alreadyKnown}, suppressed ${r.suppressed}, primary ${r.primary ?? '-'}`;

async function cleanup(db: Pool, placeId: number | null): Promise<void> {
  await db.query('DELETE FROM emails WHERE domain = $1', [DOMAIN]);
  if (placeId !== null) await db.query('DELETE FROM places WHERE id = $1', [placeId]);
  await db.query('DELETE FROM suppression WHERE domain = $1', [DOMAIN]);
  await db.query('DELETE FROM domain_crawls WHERE domain = $1', [DOMAIN]);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
  let placeId: number | null = null;
  try {
    await cleanup(db, null);
    const place = await db.query<{ id: number }>(
      `INSERT INTO places (name, name_normalized, country_code, website, website_domain, updated_at)
       VALUES ('Verify Crawl Place', 'verify crawl place', 'CY', $1, $2, now()) RETURNING id`,
      [`https://${DOMAIN}/`, DOMAIN],
    );
    placeId = place.rows[0]?.id ?? null;
    if (placeId === null) throw new Error('Could not create the test place');
    const blocked = `blocked@${DOMAIN}`;
    await db.query(
      `INSERT INTO suppression (email_hash, email_normalized, domain, reason, note)
       VALUES ($1, $2, $3, 'MANUAL', 'crawl:verify test row')`,
      [hashEmail(blocked), blocked, DOMAIN],
    );

    const input = (emails: EvaluatedEmail[]) => ({
      domain: DOMAIN,
      placeIds: [placeId as number],
      crawl: CRAWL_DONE,
      emails,
      retryWithoutEmailDays: 90,
    });
    const firstCrawl = [
      email('info', 'GENERIC', `Info@${DOMAIN.toUpperCase()}`),
      email('maria', 'PERSONAL'),
      email('blocked', 'PERSONAL'),
    ];

    console.log('Saving crawl results (test data, removed at the end)\n');
    const r1 = await saveCrawlResult(db, input(firstCrawl));
    check(
      'A. First crawl stores the 2 allowed emails, blocks the suppressed one',
      r1.inserted === 2 && r1.suppressed === 1,
      show(r1),
    );
    check(
      'B. The best email becomes primary (own domain + personal)',
      r1.primary === `maria@${DOMAIN}`,
      `primary ${r1.primary}`,
    );

    const r2 = await saveCrawlResult(db, input(firstCrawl));
    check(
      'C. Same crawl again stores NOTHING new (duplicates impossible)',
      r2.inserted === 0 && r2.alreadyKnown === 2,
      show(r2),
    );

    const r3 = await saveCrawlResult(db, input([...firstCrawl, email('new.person', 'PERSONAL')]));
    check(
      'D. Re-crawl with one new address stores only that one',
      r3.inserted === 1 && r3.alreadyKnown === 2,
      show(r3),
    );
    check(
      'E. The existing primary is kept',
      r3.primary === null,
      `primary ${r3.primary ?? 'unchanged'}`,
    );

    const rows = await db.query<{
      email_normalized: string;
      seen_count: number;
      is_primary: boolean;
      lawful_basis: string;
    }>(
      'SELECT email_normalized, seen_count, is_primary, lawful_basis FROM emails WHERE domain = $1 ORDER BY id',
      [DOMAIN],
    );
    const counts = rows.rows
      .map((r) => `${r.email_normalized.split('@')[0]}:${r.seen_count}`)
      .join(', ');
    check(
      'F. Exactly 3 rows exist; seen_count counts repeats',
      rows.rows.length === 3 && rows.rows[0]?.seen_count === 3,
      counts,
    );
    check(
      'G. Exactly one primary email for the place',
      rows.rows.filter((r) => r.is_primary).length === 1,
      `${rows.rows.filter((r) => r.is_primary).length} primary`,
    );
    check(
      'H. The suppressed email was never stored',
      !rows.rows.some((r) => r.email_normalized === blocked),
      'not in emails table',
    );
    check(
      'I. Vendor emails get lawful basis LEGITIMATE_INTEREST_B2B',
      rows.rows.every((r) => r.lawful_basis === 'LEGITIMATE_INTEREST_B2B'),
      rows.rows[0]?.lawful_basis ?? '-',
    );

    const cache = await db.query<{
      status: string;
      next_retry_at: Date | null;
      emails_found: number;
    }>('SELECT status, next_retry_at, emails_found FROM domain_crawls WHERE domain = $1', [DOMAIN]);
    const entry = cache.rows[0];
    check(
      'J. Website marked DONE and never re-crawled (it has emails)',
      entry?.status === 'DONE' && entry.next_retry_at === null,
      `${entry?.status}, next retry ${entry?.next_retry_at ?? 'never'}`,
    );

    console.log(`\nResult: ${passed}/${total} checks passed. Test data removed.`);
    if (passed !== total) process.exitCode = 1;
  } finally {
    await cleanup(db, placeId);
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});