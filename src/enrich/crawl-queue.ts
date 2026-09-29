import type { Pool } from 'pg';
import { crawlSite, type SiteCrawlResult } from '../crawler/crawl-site';
import type { CrawlerSettings } from '../crawler/settings';
import { evaluateSiteEmails, type EvaluationResult } from './evaluate';
import type { MxChecker } from './mx';
import { saveCrawlResult, type SaveCrawlResult } from './save';

/** A RUNNING claim older than this belongs to a crashed crawler and may be taken again. */
const STALE_CLAIM_MINUTES = 15;

/**
 * Websites waiting for a crawl: own website known, no email yet, not rejected,
 * and the domain was never crawled or its retry time has come. Mock data
 * ("*.example.cy") is never crawled.
 * $1 (optional timestamp): also take websites that were crawled before that moment
 * WITHOUT finding an email, ignoring the 90-day wait ("--recheck-no-email", used to
 * measure improvements of the email finder). The cut-off stops a run from picking a
 * website it has just crawled.
 */
const DUE_DOMAINS_SQL = `
  SELECT p.website_domain AS domain, min(p.id) AS first_place_id
  FROM places p
  LEFT JOIN domain_crawls d ON d.domain = p.website_domain
  WHERE p.website_domain IS NOT NULL
    AND p.website IS NOT NULL
    AND p.status <> 'REJECTED'
    AND p.website_domain !~ '(^|\\.)example\\.[a-z.]+$'
    AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.place_id = p.id)
    AND (
      d.domain IS NULL
      OR (d.status <> 'RUNNING' AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= now())
      OR (d.status = 'RUNNING' AND d.updated_at < now() - make_interval(mins => ${STALE_CLAIM_MINUTES}))
      OR ($1::timestamptz IS NOT NULL AND d.status IN ('DONE', 'FAILED') AND d.emails_found = 0 AND d.crawled_at < $1)
    )
  GROUP BY p.website_domain`;

export interface QueueOptions {
  /** Re-crawl websites where no email was found, if crawled before this moment. */
  recheckNoEmailBefore?: Date | null;
  /** Only this domain. */
  onlyDomain?: string;
}

export async function countDueDomains(db: Pool, options: QueueOptions = {}): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM (${DUE_DOMAINS_SQL}) due`,
    [options.recheckNoEmailBefore ?? null],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function listDueDomains(
  db: Pool,
  limit: number,
  options: QueueOptions = {},
): Promise<string[]> {
  const { rows } = await db.query<{ domain: string }>(
    `SELECT domain FROM (${DUE_DOMAINS_SQL}) due ORDER BY first_place_id LIMIT $2`,
    [options.recheckNoEmailBefore ?? null, limit],
  );
  return rows.map((r) => r.domain);
}

export interface ClaimedDomain {
  domain: string;
  /** Places using this website, oldest first. */
  placeIds: number[];
  /** Website URL to start from (of the oldest place). */
  website: string;
}

/**
 * Atomically takes the next due domain by marking it RUNNING in domain_crawls.
 * Two crawlers can never get the same domain: the conditional ON CONFLICT
 * update succeeds for only one of them.
 */
export async function claimNextDomain(
  db: Pool,
  options: QueueOptions = {},
): Promise<ClaimedDomain | null> {
  const { rows } = await db.query<{ domain: string }>(
    `WITH candidate AS (
       SELECT domain FROM (${DUE_DOMAINS_SQL}) due
       WHERE $2::text IS NULL OR domain = $2
       ORDER BY first_place_id
       LIMIT 1
     )
     INSERT INTO domain_crawls (domain, status, updated_at)
     SELECT domain, 'RUNNING', now() FROM candidate
     ON CONFLICT (domain) DO UPDATE SET status = 'RUNNING', updated_at = now()
       WHERE domain_crawls.status <> 'RUNNING'
          OR domain_crawls.updated_at < now() - make_interval(mins => ${STALE_CLAIM_MINUTES})
     RETURNING domain`,
    [options.recheckNoEmailBefore ?? null, options.onlyDomain ?? null],
  );
  const domain = rows[0]?.domain;
  if (!domain) return null;

  const places = await db.query<{ id: number; website: string }>(
    `SELECT id, website FROM places WHERE website_domain = $1 AND website IS NOT NULL ORDER BY id`,
    [domain],
  );
  const first = places.rows[0];
  if (!first) {
    await db.query(
      `UPDATE domain_crawls SET status = 'SKIPPED', updated_at = now() WHERE domain = $1`,
      [domain],
    );
    return null;
  }
  return { domain, placeIds: places.rows.map((r) => r.id), website: first.website };
}

export interface CrawlContext {
  db: Pool;
  settings: CrawlerSettings;
  mx: MxChecker;
  freeDomains: ReadonlySet<string>;
  /** ONLY for tests / the local demo site. */
  testOrigins?: string[];
  sleep?: (ms: number) => Promise<void>;
}

export interface DomainOutcome {
  claimed: ClaimedDomain;
  crawl: SiteCrawlResult;
  evaluation: EvaluationResult;
  saved: SaveCrawlResult;
}

/** Crawls one claimed website, evaluates the emails and stores everything. */
export async function processDomain(
  ctx: CrawlContext,
  claimed: ClaimedDomain,
): Promise<DomainOutcome> {
  try {
    const crawl = await crawlSite(claimed.website, {
      settings: ctx.settings,
      testOrigins: ctx.testOrigins,
      sleep: ctx.sleep,
    });
    const evaluation = await evaluateSiteEmails(crawl.pages, {
      websiteDomain: claimed.domain,
      freeDomains: ctx.freeDomains,
      mx: ctx.mx,
    });
    const saved = await saveCrawlResult(ctx.db, {
      domain: claimed.domain,
      placeIds: claimed.placeIds,
      crawl,
      emails: evaluation.emails,
      retryWithoutEmailDays: ctx.settings.retryWithoutEmailDays,
    });
    return { claimed, crawl, evaluation, saved };
  } catch (err) {
    // Release the claim so the domain is tried again tomorrow instead of staying RUNNING.
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db
      .query(
        `UPDATE domain_crawls SET status = 'FAILED', last_error = $2, next_retry_at = now() + interval '1 day',
                updated_at = now() WHERE domain = $1`,
        [claimed.domain, `UNEXPECTED: ${message}`.slice(0, 500)],
      )
      .catch(() => undefined);
    throw err;
  }
}

/** Loads the free-mail domain list (gmail.com, cytanet.com.cy ...). */
export async function loadFreeDomainSet(db: Pool): Promise<Set<string>> {
  const { rows } = await db.query<{ domain: string }>('SELECT domain FROM free_email_domains');
  return new Set(rows.map((r) => r.domain));
}