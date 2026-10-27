import type { Pool } from 'pg';
import type { MxChecker } from './mx';

/**
 * Emails whose mail server could not be checked when they were found (DNS gave no answer)
 * stay "not checked" and are held for review, so they never reach a download. This asks
 * again for a batch of such domains and stores the answer. The places of answered emails
 * are touched, so the lead pipeline re-evaluates them (a working mail server makes the
 * lead ready; no mail server keeps it held, now with the right reason).
 */
export interface MxRecheckResult {
  domains: number;
  withMailServer: number;
  withoutMailServer: number;
  stillUnknown: number;
  placesTouched: number;
}

export async function recheckUnknownMx(
  db: Pool,
  mx: MxChecker,
  limit = 300,
): Promise<MxRecheckResult> {
  const { rows } = await db.query<{ domain: string }>(
    `SELECT domain FROM emails WHERE mx_valid IS NULL
     GROUP BY domain ORDER BY min(id) LIMIT $1`,
    [limit],
  );
  const result: MxRecheckResult = {
    domains: rows.length,
    withMailServer: 0,
    withoutMailServer: 0,
    stillUnknown: 0,
    placesTouched: 0,
  };
  const placeIds = new Set<number>();
  for (const { domain } of rows) {
    const valid = await mx.check(domain);
    if (valid === null) {
      result.stillUnknown += 1;
      continue;
    }
    if (valid) result.withMailServer += 1;
    else result.withoutMailServer += 1;
    const updated = await db.query<{ place_id: number | null }>(
      `UPDATE emails SET mx_valid = $2, updated_at = now()
       WHERE domain = $1 AND mx_valid IS NULL RETURNING place_id`,
      [domain, valid],
    );
    for (const r of updated.rows) if (r.place_id !== null) placeIds.add(r.place_id);
  }
  if (placeIds.size > 0) {
    await db.query('UPDATE places SET updated_at = now() WHERE id = ANY($1::int[])', [
      [...placeIds],
    ]);
  }
  result.placesTouched = placeIds.size;
  return result;
}
