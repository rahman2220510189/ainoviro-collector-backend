import type { Pool } from 'pg';
import { ROLE_ADDRESS_SQL } from './classify';
import type { MxChecker } from './mx';

/**
 * Mail-server answers are asked again:
 *  - "not checked" (DNS gave no answer when the email was found): held for review, so
 *    they never reached a download until answered (step 7.3);
 *  - "no mail server": until step 7.4 any DNS error on the host was stored as "no mail
 *    server", which held good leads back for ever. These are confirmed again once, and
 *    then every RECHECK_NO_MX_DAYS (a domain can get a mail server later).
 * Places of changed emails are touched, so the lead pipeline re-evaluates them.
 */
export const RECHECK_NO_MX_DAYS = 14;

export interface MxRecheckResult {
  domains: number;
  withMailServer: number;
  withoutMailServer: number;
  stillUnknown: number;
  /** Emails stored as "no mail server" that do have one. */
  corrected: number;
  placesTouched: number;
}

export async function recheckMx(db: Pool, mx: MxChecker, limit = 300): Promise<MxRecheckResult> {
  // "Not checked" first, then the "no" answers never or longest ago confirmed.
  const { rows } = await db.query<{ domain: string }>(
    `SELECT domain FROM emails
     WHERE mx_valid IS NULL
        OR (mx_valid = false AND (mx_checked_at IS NULL
            OR mx_checked_at < now() - make_interval(days => $2)))
     GROUP BY domain
     ORDER BY bool_or(mx_valid IS NULL) DESC, max(mx_checked_at) NULLS FIRST, min(id)
     LIMIT $1`,
    [limit, RECHECK_NO_MX_DAYS],
  );
  const result: MxRecheckResult = {
    domains: rows.length,
    withMailServer: 0,
    withoutMailServer: 0,
    stillUnknown: 0,
    corrected: 0,
    placesTouched: 0,
  };
  const placeIds = new Set<number>();
  for (const { domain } of rows) {
    const valid = await mx.check(domain);
    if (valid === null) {
      result.stillUnknown += 1;
      // Keep the old answer; ask again in about a day (not in the very next batch).
      await db.query(
        `UPDATE emails SET mx_checked_at = now() - make_interval(days => $2 - 1)
         WHERE domain = $1 AND (mx_valid IS NULL OR mx_valid = false)`,
        [domain, RECHECK_NO_MX_DAYS],
      );
      continue;
    }
    if (valid) result.withMailServer += 1;
    else result.withoutMailServer += 1;
    const changed = await db.query<{ place_id: number | null; was: boolean | null }>(
      `UPDATE emails e SET mx_valid = $2, mx_checked_at = now(), updated_at = now()
       FROM (SELECT id, mx_valid AS was FROM emails
             WHERE domain = $1 AND (mx_valid IS NULL OR mx_valid = false)
               AND mx_valid IS DISTINCT FROM $2) old
       WHERE e.id = old.id
       RETURNING e.place_id, old.was`,
      [domain, valid],
    );
    for (const r of changed.rows) {
      if (r.place_id !== null) placeIds.add(r.place_id);
      if (r.was === false && valid) result.corrected += 1;
    }
    // Confirmed "no": remember when, so it is asked again only after RECHECK_NO_MX_DAYS.
    if (!valid)
      await db.query(
        'UPDATE emails SET mx_checked_at = now() WHERE domain = $1 AND mx_valid = false',
        [domain],
      );
  }
  if (placeIds.size > 0) {
    await db.query('UPDATE places SET updated_at = now() WHERE id = ANY($1::int[])', [
      [...placeIds],
    ]);
  }
  result.placesTouched = placeIds.size;
  return result;
}

export interface PrimaryFixResult {
  /** Places whose primary email was replaced by a better one. */
  replaced: number;
}

/**
 * Places not yet exported whose primary email cannot be used (no mail server, or a
 * data-protection/legal mailbox such as privacy@ or dpo@) get another of their own
 * emails as primary, when one has a working mail server and looks like a business
 * address (own domain, or a generic mailbox such as info@). A person's private address
 * on a free-mail domain is never promoted. Exported places are not touched.
 */
export async function fixPrimaryEmails(db: Pool, limit = 500): Promise<PrimaryFixResult> {
  const { rows } = await db.query<{ place_id: number; old_id: number; new_id: number }>(
    `WITH bad AS (
       SELECT e.id AS old_id, e.place_id
       FROM emails e JOIN places p ON p.id = e.place_id
       WHERE e.is_primary AND p.status = 'NEW' AND e.exported_at IS NULL
         AND (e.mx_valid = false OR e.email_normalized ~ $1)
     )
     SELECT DISTINCT ON (b.place_id) b.place_id, b.old_id, a.id AS new_id
     FROM bad b JOIN emails a ON a.place_id = b.place_id AND a.id <> b.old_id
     WHERE a.mx_valid = true AND a.email_normalized !~ $1 AND NOT a.is_disposable
       AND a.exported_at IS NULL AND a.status = 'NEW'
       AND (a.is_own_domain OR a.email_type = 'GENERIC')
     ORDER BY b.place_id, a.is_own_domain DESC, (a.email_type = 'PERSONAL') DESC, a.id
     LIMIT $2`,
    [ROLE_ADDRESS_SQL, limit],
  );
  if (rows.length === 0) return { replaced: 0 };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Old ones off first: at most one primary per place (unique index).
    await client.query(
      'UPDATE emails SET is_primary = false, updated_at = now() WHERE id = ANY($1::int[])',
      [rows.map((r) => r.old_id)],
    );
    await client.query(
      'UPDATE emails SET is_primary = true, updated_at = now() WHERE id = ANY($1::int[])',
      [rows.map((r) => r.new_id)],
    );
    await client.query('UPDATE places SET updated_at = now() WHERE id = ANY($1::int[])', [
      rows.map((r) => r.place_id),
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { replaced: rows.length };
}
