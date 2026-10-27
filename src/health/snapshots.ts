import type { Pool } from 'pg';
import { countReadyLeads } from '../leads/process';

/** Snapshots older than this are deleted. */
export const SNAPSHOT_KEEP_DAYS = 45;

export interface HealthCounts {
  ready: number;
  /** New leads with an email held back for review. */
  needsReview: number;
  /** Held leads per reason (one lead can have several reasons). */
  reasons: Record<string, number>;
  emailsTotal: number;
  exportedTotal: number;
}

export interface HealthSnapshot extends HealthCounts {
  takenAt: string;
}

const num = (v: unknown): number => Number(v ?? 0);

/** The numbers a snapshot stores, read now (also used live by the dashboard). */
export async function healthCounts(db: Pool, country: string): Promise<HealthCounts> {
  const [ready, reasons, held, emails] = await Promise.all([
    countReadyLeads(db, country),
    db.query<{ reason: string; n: string }>(
      `SELECT r.reason, count(*) AS n
       FROM places p CROSS JOIN LATERAL unnest(p.review_reasons) AS r(reason)
       WHERE p.country_code = $1 AND p.status = 'NEW' AND p.needs_review
       GROUP BY r.reason`,
      [country],
    ),
    // Held places counted once (a place with two reasons is one lead).
    db.query<{ n: string }>(
      `SELECT count(*) AS n FROM places p
       WHERE p.country_code = $1 AND p.status = 'NEW' AND p.needs_review`,
      [country],
    ),
    db.query<{ total: string; exported: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE e.exported_at IS NOT NULL) AS exported
       FROM emails e JOIN places p ON p.id = e.place_id WHERE p.country_code = $1`,
      [country],
    ),
  ]);
  const byReason: Record<string, number> = {};
  for (const r of reasons.rows) byReason[r.reason] = num(r.n);
  return {
    ready,
    needsReview: num(held.rows[0]?.n),
    reasons: byReason,
    emailsTotal: num(emails.rows[0]?.total),
    exportedTotal: num(emails.rows[0]?.exported),
  };
}

/** Stores one snapshot per country that has places, and deletes old ones. */
export async function takeHealthSnapshots(db: Pool): Promise<number> {
  const { rows } = await db.query<{ country_code: string }>(
    'SELECT DISTINCT country_code FROM places',
  );
  for (const { country_code: country } of rows) {
    const c = await healthCounts(db, country);
    await db.query(
      `INSERT INTO health_snapshots
         (country_code, ready, needs_review, reasons, emails_total, exported_total)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [country, c.ready, c.needsReview, JSON.stringify(c.reasons), c.emailsTotal, c.exportedTotal],
    );
  }
  await db.query(
    `DELETE FROM health_snapshots WHERE taken_at < now() - make_interval(days => $1)`,
    [SNAPSHOT_KEEP_DAYS],
  );
  return rows.length;
}

/**
 * The newest snapshot at least `hoursAgo` old, but not older than `hoursAgo + 12`
 * (an older one would compare against a different situation). Null when there is none.
 */
export async function snapshotAgo(
  db: Pool,
  country: string,
  hoursAgo: number,
): Promise<HealthSnapshot | null> {
  const { rows } = await db.query<{
    taken_at: Date;
    ready: number;
    needs_review: number;
    reasons: Record<string, number> | null;
    emails_total: number;
    exported_total: number;
  }>(
    `SELECT taken_at, ready, needs_review, reasons, emails_total, exported_total
     FROM health_snapshots
     WHERE country_code = $1
       AND taken_at <= now() - make_interval(hours => $2)
       AND taken_at >= now() - make_interval(hours => $2 + 12)
     ORDER BY taken_at DESC LIMIT 1`,
    [country, hoursAgo],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    takenAt: new Date(r.taken_at).toISOString(),
    ready: num(r.ready),
    needsReview: num(r.needs_review),
    reasons: r.reasons ?? {},
    emailsTotal: num(r.emails_total),
    exportedTotal: num(r.exported_total),
  };
}
