import type { Pool } from 'pg';
import { countDueDomains } from '../enrich/crawl-queue';
import { scopeSql } from '../export/export-service';
import { GOOGLE_PROVIDER, GOOGLE_TEXT_SEARCH_SKU } from '../quota/quota-guard';

/** Dates on the dashboard follow Cyprus time. */
const TZ = 'Asia/Nicosia';
/** Days shown in the activity chart. */
export const ACTIVITY_DAYS = 30;
/** Months shown in the Google history. */
const GOOGLE_MONTHS = 6;

export interface DashboardSummary {
  country: string;
  generatedAt: string;
  leads: {
    /** Businesses ever found. */
    totalPlaces: number;
    /** Businesses with at least one email. */
    withEmail: number;
    /** New, checked, not exported yet: what "Download CSV" would give now. */
    ready: number;
    /** New with an email, but held back until checked. */
    needsReview: number;
    /** Held back as chains (many branches, one head office). */
    chains: number;
    /** Closed on Google (never exported). */
    closed: number;
    /** Count per status (NEW, EXPORTED, CONTACTED, ...). Only businesses with an email. */
    byStatus: Record<string, number>;
  };
  emails: {
    total: number;
    generic: number;
    personal: number;
    ownDomain: number;
    freeMail: number;
    /** Domain has no mail server. */
    noMailServer: number;
    bounced: number;
    unsubscribed: number;
    exported: number;
    newThisMonth: number;
  };
  websites: {
    /** Businesses with their own website. */
    withWebsite: number;
    /** Websites (domains) crawled at least once. */
    crawled: number;
    emailFound: number;
    noEmailFound: number;
    failed: number;
    robotsBlocked: number;
    /** Websites the worker will crawl next (not crawled yet, or due again). */
    waiting: number;
  };
  google: {
    /** Real Google requests per month, newest last. */
    months: { period: string; requests: number; paid: number }[];
  };
  exports: {
    batches: number;
    rows: number;
    rowsThisMonth: number;
    lastExportAt: string | null;
  };
  suppression: { total: number; byReason: Record<string, number> };
  jobs: { byStatus: Record<string, number> };
  topCities: { name: string; withEmail: number; ready: number }[];
  topCategories: { name: string; withEmail: number; ready: number }[];
  /** One row per day for the last ACTIVITY_DAYS days, oldest first. */
  activity: { date: string; newPlaces: number; newEmails: number; exported: number }[];
}

export interface DashboardService {
  summary(country: string): Promise<DashboardSummary>;
}

const num = (v: unknown): number => Number(v ?? 0);

/** Turns rows of { key, n } into { key: n }. */
function counts(rows: { key: string | null; n: string | number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) if (r.key !== null) out[r.key] = num(r.n);
  return out;
}

/** Everything on the dashboard, read in parallel with plain SQL (read only). */
export function createDashboardService(db: Pool): DashboardService {
  return {
    async summary(country) {
      const month = `date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
      const ready = scopeSql('new');

      const [
        leads,
        byStatus,
        emails,
        websites,
        google,
        exportsRow,
        suppression,
        jobs,
        topCities,
        topCategories,
        activity,
        waiting,
      ] = await Promise.all([
        db.query(
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE has_email) AS with_email,
                  count(*) FILTER (WHERE has_email AND needs_review AND status = 'NEW') AS review,
                  count(*) FILTER (WHERE has_email AND is_chain AND status = 'NEW') AS chains,
                  count(*) FILTER (WHERE business_status IN ('CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY')) AS closed,
                  (SELECT count(*) FROM places p JOIN emails e ON e.place_id = p.id AND e.is_primary
                   WHERE ${ready}) AS ready
           FROM (SELECT p.*, EXISTS (SELECT 1 FROM emails e WHERE e.place_id = p.id) AS has_email
                 FROM places p WHERE p.country_code = $1) x`,
          [country],
        ),
        db.query<{ key: string; n: string }>(
          `SELECT p.status::text AS key, count(*) AS n FROM places p
           WHERE p.country_code = $1 AND EXISTS (SELECT 1 FROM emails e WHERE e.place_id = p.id)
           GROUP BY 1`,
          [country],
        ),
        db.query(
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE e.email_type = 'GENERIC') AS generic,
                  count(*) FILTER (WHERE e.email_type = 'PERSONAL') AS personal,
                  count(*) FILTER (WHERE e.is_own_domain) AS own_domain,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM free_email_domains f WHERE f.domain = e.domain)) AS free_mail,
                  count(*) FILTER (WHERE e.mx_valid = false) AS no_mx,
                  count(*) FILTER (WHERE e.status = 'BOUNCED') AS bounced,
                  count(*) FILTER (WHERE e.status = 'UNSUBSCRIBED') AS unsubscribed,
                  count(*) FILTER (WHERE e.exported_at IS NOT NULL) AS exported,
                  count(*) FILTER (WHERE e.first_seen_at >= ${month}) AS new_month
           FROM emails e JOIN places p ON p.id = e.place_id
           WHERE p.country_code = $1`,
          [country],
        ),
        db.query(
          `WITH own AS (
             SELECT DISTINCT p.website_domain AS domain FROM places p
             WHERE p.country_code = $1 AND p.website IS NOT NULL AND p.website_domain IS NOT NULL
               AND p.status <> 'REJECTED' AND p.website_domain !~ '(^|\\.)example\\.[a-z.]+$')
           SELECT (SELECT count(*) FROM places p WHERE p.country_code = $1 AND p.website IS NOT NULL
                     AND p.website_domain IS NOT NULL AND p.website_domain !~ '(^|\\.)example\\.[a-z.]+$') AS with_website,
                  count(d.domain) FILTER (WHERE d.crawled_at IS NOT NULL) AS crawled,
                  count(*) FILTER (WHERE d.emails_found > 0) AS email_found,
                  count(*) FILTER (WHERE d.status = 'DONE' AND d.emails_found = 0 AND NOT d.robots_blocked) AS no_email,
                  count(*) FILTER (WHERE d.status = 'FAILED') AS failed,
                  count(*) FILTER (WHERE d.robots_blocked) AS robots
           FROM own LEFT JOIN domain_crawls d ON d.domain = own.domain`,
          [country],
        ),
        db.query<{ period: string; requests: number; paid: number }>(
          `SELECT period, request_count AS requests, paid_count AS paid FROM api_usage
           WHERE provider = $1 AND sku = $2 ORDER BY period DESC LIMIT ${GOOGLE_MONTHS}`,
          [GOOGLE_PROVIDER, GOOGLE_TEXT_SEARCH_SKU],
        ),
        db.query(
          `SELECT count(*) FILTER (WHERE status = 'ACTIVE') AS batches,
                  coalesce(sum(row_count) FILTER (WHERE status = 'ACTIVE'), 0) AS rows,
                  coalesce(sum(row_count) FILTER (WHERE status = 'ACTIVE' AND created_at >= ${month}), 0) AS rows_month,
                  max(created_at) FILTER (WHERE status = 'ACTIVE') AS last_at
           FROM export_batches`,
        ),
        db.query<{ key: string; n: string }>(
          `SELECT reason::text AS key, count(*) AS n FROM suppression GROUP BY 1`,
        ),
        db.query<{ key: string; n: string }>(
          `SELECT status::text AS key, count(*) AS n FROM jobs GROUP BY 1`,
        ),
        db.query<{ name: string; with_email: string; ready: string }>(
          `SELECT coalesce(p.city_name, 'Unknown') AS name, count(*) AS with_email,
                  count(*) FILTER (WHERE ${ready}) AS ready
           FROM places p JOIN emails e ON e.place_id = p.id AND e.is_primary
           WHERE p.country_code = $1
           GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
          [country],
        ),
        db.query<{ name: string; with_email: string; ready: string }>(
          `SELECT coalesce(c.display_name, 'No category') AS name, count(*) AS with_email,
                  count(*) FILTER (WHERE ${ready}) AS ready
           FROM places p JOIN emails e ON e.place_id = p.id AND e.is_primary
           LEFT JOIN place_subcategories ps ON ps.place_id = p.id AND ps.is_primary
           LEFT JOIN subcategories s ON s.id = ps.subcategory_id
           LEFT JOIN categories c ON c.id = s.category_id
           WHERE p.country_code = $1
           GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
          [country],
        ),
        db.query<{ day: string; new_places: string; new_emails: string; exported: string }>(
          `WITH days AS (
             SELECT generate_series(
               (now() AT TIME ZONE '${TZ}')::date - ${ACTIVITY_DAYS - 1},
               (now() AT TIME ZONE '${TZ}')::date, interval '1 day')::date AS day)
           SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
             (SELECT count(*) FROM places p WHERE p.country_code = $1
                AND (p.first_seen_at AT TIME ZONE '${TZ}')::date = d.day) AS new_places,
             (SELECT count(*) FROM emails e JOIN places p ON p.id = e.place_id WHERE p.country_code = $1
                AND (e.first_seen_at AT TIME ZONE '${TZ}')::date = d.day) AS new_emails,
             (SELECT coalesce(sum(b.row_count), 0) FROM export_batches b WHERE b.status = 'ACTIVE'
                AND (b.created_at AT TIME ZONE '${TZ}')::date = d.day) AS exported
           FROM days d ORDER BY d.day`,
          [country],
        ),
        // Same rule the worker uses to pick the next website (all countries).
        countDueDomains(db),
      ]);

      const l = leads.rows[0] ?? {};
      const e = emails.rows[0] ?? {};
      const w = websites.rows[0] ?? {};
      const x = exportsRow.rows[0] ?? {};
      const byReason = counts(suppression.rows);

      return {
        country,
        generatedAt: new Date().toISOString(),
        leads: {
          totalPlaces: num(l.total),
          withEmail: num(l.with_email),
          ready: num(l.ready),
          needsReview: num(l.review),
          chains: num(l.chains),
          closed: num(l.closed),
          byStatus: counts(byStatus.rows),
        },
        emails: {
          total: num(e.total),
          generic: num(e.generic),
          personal: num(e.personal),
          ownDomain: num(e.own_domain),
          freeMail: num(e.free_mail),
          noMailServer: num(e.no_mx),
          bounced: num(e.bounced),
          unsubscribed: num(e.unsubscribed),
          exported: num(e.exported),
          newThisMonth: num(e.new_month),
        },
        websites: {
          withWebsite: num(w.with_website),
          crawled: num(w.crawled),
          emailFound: num(w.email_found),
          noEmailFound: num(w.no_email),
          failed: num(w.failed),
          robotsBlocked: num(w.robots),
          waiting,
        },
        google: {
          months: google.rows
            .map((r) => ({ period: r.period, requests: num(r.requests), paid: num(r.paid) }))
            .reverse(),
        },
        exports: {
          batches: num(x.batches),
          rows: num(x.rows),
          rowsThisMonth: num(x.rows_month),
          lastExportAt: x.last_at ? new Date(x.last_at as string).toISOString() : null,
        },
        suppression: {
          total: Object.values(byReason).reduce((a, b) => a + b, 0),
          byReason,
        },
        jobs: { byStatus: counts(jobs.rows) },
        topCities: topCities.rows.map((r) => ({
          name: r.name,
          withEmail: num(r.with_email),
          ready: num(r.ready),
        })),
        topCategories: topCategories.rows.map((r) => ({
          name: r.name,
          withEmail: num(r.with_email),
          ready: num(r.ready),
        })),
        activity: activity.rows.map((r) => ({
          date: r.day,
          newPlaces: num(r.new_places),
          newEmails: num(r.new_emails),
          exported: num(r.exported),
        })),
      };
    },
  };
}
