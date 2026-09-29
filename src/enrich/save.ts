import type { Pool, PoolClient } from 'pg';
import type { SiteCrawlResult } from '../crawler/crawl-site';
import { hashEmail } from '../lib/email';
import { pickPrimaryIndex } from './classify';
import type { EvaluatedEmail } from './evaluate';

export interface SaveCrawlInput {
  domain: string;
  /** Places using this website; emails are attached to the first one (lowest id). */
  placeIds: number[];
  crawl: SiteCrawlResult;
  emails: EvaluatedEmail[];
  /** Days before a site without emails (or a permanent failure) is tried again. */
  retryWithoutEmailDays: number;
}

export interface SaveCrawlResult {
  /** Brand-new addresses stored. */
  inserted: number;
  /** Addresses that were already in the database (their seen_count went up). */
  alreadyKnown: number;
  /** Addresses on the suppression list: never stored. */
  suppressed: number;
  /** The address that became the place's primary email in this run, if any. */
  primary: string | null;
}

/** Days until the next attempt, or null = never again (emails were found). */
export function nextRetryDays(
  crawl: SiteCrawlResult,
  emailCount: number,
  retryWithoutEmailDays: number,
): number | null {
  if (crawl.outcome === 'DONE') return emailCount > 0 ? null : retryWithoutEmailDays;
  if (crawl.outcome === 'FAILED' && crawl.error?.retryable) return 1;
  return retryWithoutEmailDays;
}

async function findSuppressed(client: PoolClient, emails: EvaluatedEmail[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const { rows } = await client.query<{ email_hash: string | null; domain: string | null }>(
    `SELECT email_hash, domain FROM suppression
     WHERE email_hash = ANY($1::text[]) OR (email_hash IS NULL AND domain = ANY($2::text[]))`,
    [emails.map((e) => hashEmail(e.normalized)), [...new Set(emails.map((e) => e.domain))]],
  );
  const hashes = new Set(rows.map((r) => r.email_hash).filter((h): h is string => h !== null));
  const domains = new Set(rows.filter((r) => r.email_hash === null).map((r) => r.domain));
  return new Set(
    emails
      .filter((e) => hashes.has(hashEmail(e.normalized)) || domains.has(e.domain))
      .map((e) => e.normalized),
  );
}

/**
 * Stores one website's crawl in ONE transaction:
 *  1. suppression check (email hash or blocked domain): suppressed addresses are never stored;
 *  2. INSERT ... ON CONFLICT (email_normalized): a new address is stored once; an address
 *     that already exists only gets seen_count + 1 (the UNIQUE index makes duplicates impossible);
 *  3. if the place has no primary email yet, the best NEW address becomes primary;
 *  4. places.last_crawled_at and the domain_crawls cache entry are updated.
 */
export async function saveCrawlResult(db: Pool, input: SaveCrawlInput): Promise<SaveCrawlResult> {
  const placeId = input.placeIds[0];
  if (placeId === undefined) throw new Error(`No place for domain ${input.domain}`);
  const result: SaveCrawlResult = { inserted: 0, alreadyKnown: 0, suppressed: 0, primary: null };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const suppressed = await findSuppressed(client, input.emails);
    result.suppressed = suppressed.size;
    const toStore = input.emails.filter((e) => !suppressed.has(e.normalized));

    if (toStore.length > 0) {
      const saved = await client.query<{ id: number; email_normalized: string; inserted: boolean }>(
        `INSERT INTO emails (
           email, email_normalized, domain, place_id, lead_type, is_primary, email_type,
           is_own_domain, syntax_valid, mx_valid, is_disposable, source, source_url, lawful_basis, updated_at
         )
         SELECT u.email, u.normalized, u.domain, p.id, p.lead_type, false, u.email_type::email_type,
                u.own, true, u.mx, u.disposable, u.source, u.source_url,
                CASE WHEN p.lead_type = 'VENDOR' THEN 'LEGITIMATE_INTEREST_B2B'::lawful_basis
                     ELSE 'UNKNOWN'::lawful_basis END,
                now()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::bool[], $7::bool[], $8::bool[], $9::text[], $10::text[])
           AS u(email, normalized, domain, email_type, own, mx, disposable, source, source_url)
         JOIN places p ON p.id = $1
         ON CONFLICT (email_normalized) DO UPDATE SET
           seen_count = emails.seen_count + 1,
           last_seen_at = now(),
           updated_at = now()
         RETURNING id, email_normalized, (xmax = 0) AS inserted`,
        [
          placeId,
          toStore.map((e) => e.original),
          toStore.map((e) => e.normalized),
          toStore.map((e) => e.domain),
          toStore.map((e) => e.emailType),
          toStore.map((e) => e.isOwnDomain),
          toStore.map((e) => e.mxValid),
          toStore.map((e) => e.isDisposable),
          toStore.map((e) => e.source),
          toStore.map((e) => e.sourceUrl),
        ],
      );
      const insertedIds = new Map(
        saved.rows.filter((r) => r.inserted).map((r) => [r.email_normalized, r.id]),
      );
      result.inserted = insertedIds.size;
      result.alreadyKnown = saved.rows.length - insertedIds.size;

      const hasPrimary = await client.query(
        'SELECT 1 FROM emails WHERE place_id = $1 AND is_primary',
        [placeId],
      );
      const candidates = toStore.filter((e) => insertedIds.has(e.normalized));
      if (hasPrimary.rowCount === 0 && candidates.length > 0) {
        const best =
          candidates[
            pickPrimaryIndex(candidates.map((e) => (e.isDisposable ? { ...e, mxValid: false } : e)))
          ];
        const bestId = best ? insertedIds.get(best.normalized) : undefined;
        if (best && bestId !== undefined) {
          await client.query(
            'UPDATE emails SET is_primary = true, updated_at = now() WHERE id = $1',
            [bestId],
          );
          result.primary = best.normalized;
        }
      }
    }

    await client.query(
      'UPDATE places SET last_crawled_at = now(), updated_at = now() WHERE id = ANY($1::int[])',
      [input.placeIds],
    );

    const retryDays = nextRetryDays(input.crawl, input.emails.length, input.retryWithoutEmailDays);
    const status =
      input.crawl.outcome === 'DONE'
        ? 'DONE'
        : input.crawl.outcome === 'ROBOTS_BLOCKED'
          ? 'SKIPPED'
          : 'FAILED';
    await client.query(
      `INSERT INTO domain_crawls (domain, status, pages_fetched, emails_found, robots_blocked, last_error,
                                  crawled_at, next_retry_at, updated_at)
       VALUES ($1, $2::crawl_status, $3, $4, $5, $6, now(),
               CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END, now())
       ON CONFLICT (domain) DO UPDATE SET
         status = EXCLUDED.status, pages_fetched = EXCLUDED.pages_fetched, emails_found = EXCLUDED.emails_found,
         robots_blocked = EXCLUDED.robots_blocked, last_error = EXCLUDED.last_error,
         crawled_at = EXCLUDED.crawled_at, next_retry_at = EXCLUDED.next_retry_at, updated_at = now()`,
      [
        input.domain,
        status,
        input.crawl.pages.length,
        input.emails.length,
        input.crawl.outcome === 'ROBOTS_BLOCKED',
        input.crawl.error
          ? `${input.crawl.error.code}: ${input.crawl.error.message}`.slice(0, 500)
          : null,
        retryDays,
      ],
    );

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}