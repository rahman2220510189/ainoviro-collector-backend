import type { Pool } from 'pg';
import { crawlSite, type SiteCrawlResult } from '../crawler/crawl-site';
import type { CrawlerSettings } from '../crawler/settings';
import { detectOnlineSelling } from './online-shop';

/**
 * Online-shop check (step 6.3). Websites crawled for emails are checked on all their
 * pages (see recordShopCheck in processDomain). Businesses that already HAVE an email
 * (most Overture leads) are never crawled for emails, so their home page alone is read
 * here, once, politely (robots.txt respected), to see whether they sell online.
 */

/** A check is repeated after this long (shops open and close). */
export const SHOP_RECHECK_DAYS = 180;
/** A RUNNING claim older than this belongs to a stopped worker. */
const STALE_MINUTES = 15;

export async function recordShopCheck(
  db: Pool,
  domain: string,
  crawl: Pick<SiteCrawlResult, 'outcome' | 'pages' | 'error'>,
): Promise<void> {
  if (crawl.outcome === 'DONE' && crawl.pages.length > 0) {
    const found = detectOnlineSelling(crawl.pages);
    await db.query(
      `INSERT INTO domain_shop_checks (domain, status, sells_online, signals, last_error, checked_at, updated_at)
       VALUES ($1, 'DONE', $2, $3::text[], NULL, now(), now())
       ON CONFLICT (domain) DO UPDATE SET status = 'DONE', sells_online = EXCLUDED.sells_online,
         signals = EXCLUDED.signals, last_error = NULL, checked_at = now(), updated_at = now()`,
      [domain, found.sellsOnline, found.signals],
    );
    // The lead score uses it: let the worker's lead refresh pick these places up.
    if (found.sellsOnline) {
      await db.query('UPDATE places SET updated_at = now() WHERE website_domain = $1', [domain]);
    }
    return;
  }
  const status = crawl.outcome === 'ROBOTS_BLOCKED' ? 'ROBOTS_BLOCKED' : 'FAILED';
  await db.query(
    `INSERT INTO domain_shop_checks (domain, status, last_error, checked_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (domain) DO UPDATE SET status = EXCLUDED.status, last_error = EXCLUDED.last_error,
       checked_at = now(), updated_at = now()`,
    [domain, status, crawl.error?.message?.slice(0, 500) ?? null],
  );
}

/** Websites of businesses with an email that were never checked (or long ago). */
const DUE_SQL = `
  SELECT p.website_domain AS domain, min(p.id) AS first_place_id
  FROM places p
  LEFT JOIN domain_shop_checks c ON c.domain = p.website_domain
  WHERE p.website_domain IS NOT NULL AND p.website IS NOT NULL
    AND p.status <> 'REJECTED'
    AND p.website_domain !~ '(^|\\.)example\\.[a-z.]+$'
    AND EXISTS (SELECT 1 FROM emails e WHERE e.place_id = p.id)
    AND (
      c.domain IS NULL
      OR (c.status <> 'RUNNING' AND c.checked_at < now() - make_interval(days => ${SHOP_RECHECK_DAYS}))
      OR (c.status = 'RUNNING' AND c.updated_at < now() - make_interval(mins => ${STALE_MINUTES}))
    )
  GROUP BY p.website_domain`;

export async function countDueShopChecks(db: Pool): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM (${DUE_SQL}) due`);
  return Number(rows[0]?.n ?? 0);
}

/** Atomically takes the next website to check (two workers never get the same one). */
export async function claimNextShopCheck(
  db: Pool,
  /** Only this website (verification). */
  onlyDomain: string | null = null,
): Promise<{ domain: string; website: string } | null> {
  const { rows } = await db.query<{ domain: string }>(
    `WITH candidate AS (
       SELECT domain FROM (${DUE_SQL}) due WHERE $1::text IS NULL OR domain = $1
       ORDER BY first_place_id LIMIT 1
     )
     INSERT INTO domain_shop_checks (domain, status, updated_at)
     SELECT domain, 'RUNNING', now() FROM candidate
     ON CONFLICT (domain) DO UPDATE SET status = 'RUNNING', updated_at = now()
       WHERE domain_shop_checks.status <> 'RUNNING'
          OR domain_shop_checks.updated_at < now() - make_interval(mins => ${STALE_MINUTES})
     RETURNING domain`,
    [onlyDomain],
  );
  const domain = rows[0]?.domain;
  if (!domain) return null;
  const site = await db.query<{ website: string }>(
    'SELECT website FROM places WHERE website_domain = $1 AND website IS NOT NULL ORDER BY id LIMIT 1',
    [domain],
  );
  const website = site.rows[0]?.website;
  if (!website) {
    await db.query(`DELETE FROM domain_shop_checks WHERE domain = $1 AND status = 'RUNNING'`, [
      domain,
    ]);
    return null;
  }
  return { domain, website };
}

/** Reads the home page only (robots.txt respected) and stores what it shows. */
export async function runShopCheck(
  db: Pool,
  claimed: { domain: string; website: string },
  settings: CrawlerSettings,
  testOrigins?: string[],
): Promise<{ sellsOnline: boolean | null; signals: string[] }> {
  const crawl = await crawlSite(claimed.website, {
    settings: { ...settings, maxPagesPerDomain: 1 },
    testOrigins,
  });
  await recordShopCheck(db, claimed.domain, crawl);
  if (crawl.outcome !== 'DONE') return { sellsOnline: null, signals: [] };
  return detectOnlineSelling(crawl.pages);
}
