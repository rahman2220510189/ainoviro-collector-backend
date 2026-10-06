import type { Pool } from 'pg';
import { overtureMappingReport, type MappingReport } from './category-map';
import { compareReleases, latestOvertureRelease } from './overture';
import { readRefreshState, requestRefresh, type RefreshState } from './refresh';
import { loadDatasetSettings } from './settings';
import { databaseSize } from './storage';

export interface OvertureImportView {
  id: number;
  release: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  /** Places kept for this country (after confidence and closed filters). */
  placesKept: number | null;
  error: string | null;
}

export interface OvertureStatus {
  countryCode: string;
  /** Newest successful import (what the data is based on). */
  current: OvertureImportView | null;
  /** The last few runs, newest first (also failed ones). */
  history: OvertureImportView[];
  /** Businesses in the main tables that Overture knows. */
  businesses: number;
  businessesWithEmail: number;
  /** Own website, no email yet: waiting for the worker's crawler. */
  websitesWaiting: number;
  minConfidence: number;
  /** A fixed release from the settings; null = always the newest. */
  pinnedRelease: string | null;
  refresh: RefreshState;
  /** Whole database, in bytes (the free Neon plan has little room). */
  databaseBytes: number;
}

export interface DatasetService {
  overtureStatus(country: string): Promise<OvertureStatus>;
  /** Newest release on Overture's servers and whether it is newer than this country's. */
  overtureLatest(
    country: string,
  ): Promise<{ release: string | null; newer: boolean; error: string | null }>;
  overtureReport(country: string): Promise<MappingReport>;
  requestOvertureRefresh(country: string, adminId: number | null): Promise<RefreshState>;
}

/** Overture's release list changes once a month: ask at most every few hours. */
const LATEST_CACHE_MS = 6 * 60 * 60_000;

export function createDatasetService(
  db: Pool,
  options: { latestRelease?: () => Promise<string> } = {},
): DatasetService {
  const findLatest = options.latestRelease ?? (() => latestOvertureRelease());
  let latestCache: { release: string; at: number } | null = null;

  async function imports(country: string): Promise<OvertureImportView[]> {
    const { rows } = await db.query<{
      id: number;
      release: string;
      status: string;
      started_at: Date;
      finished_at: Date | null;
      kept: string | null;
      error: string | null;
    }>(
      `SELECT id, release, status, started_at, finished_at, stats->>'kept' AS kept, error
       FROM dataset_imports
       WHERE source = 'OVERTURE' AND country_code = $1 AND release NOT IN ('local', 'fixture')
       ORDER BY id DESC LIMIT 5`,
      [country],
    );
    return rows.map((r) => ({
      id: r.id,
      release: r.release,
      status: r.status,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
      placesKept: r.kept === null ? null : Number(r.kept),
      error: r.error,
    }));
  }

  async function currentRelease(country: string): Promise<string | null> {
    const { rows } = await db.query<{ release: string }>(
      `SELECT release FROM dataset_imports
       WHERE source = 'OVERTURE' AND country_code = $1 AND status = 'DONE'
       ORDER BY id DESC LIMIT 1`,
      [country],
    );
    return rows[0]?.release ?? null;
  }

  return {
    async overtureStatus(country) {
      const [history, counts, settings, refresh, size] = await Promise.all([
        imports(country),
        db.query<{ businesses: number; with_email: number; waiting: number }>(
          `SELECT count(*)::int AS businesses,
                  count(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM emails e WHERE e.place_id = p.id AND e.mx_valid IS NOT FALSE
                  ))::int AS with_email,
                  count(*) FILTER (WHERE p.website_domain IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.place_id = p.id)
                    AND NOT EXISTS (SELECT 1 FROM domain_crawls d
                                    WHERE d.domain = p.website_domain
                                      AND d.status IN ('DONE', 'FAILED', 'SKIPPED')))::int AS waiting
           FROM places p
           WHERE p.country_code = $1
             AND EXISTS (SELECT 1 FROM place_sources s
                         WHERE s.place_id = p.id AND s.source = 'OVERTURE')`,
          [country],
        ),
        loadDatasetSettings(db),
        readRefreshState(db),
        databaseSize(db),
      ]);
      const c = counts.rows[0];
      return {
        countryCode: country,
        current: history.find((h) => h.status === 'DONE') ?? null,
        history,
        businesses: c?.businesses ?? 0,
        businessesWithEmail: c?.with_email ?? 0,
        websitesWaiting: c?.waiting ?? 0,
        minConfidence: settings.overture.minConfidence,
        pinnedRelease: settings.overture.release,
        refresh,
        databaseBytes: size.totalBytes,
      };
    },

    async overtureLatest(country) {
      try {
        if (!latestCache || Date.now() - latestCache.at > LATEST_CACHE_MS) {
          latestCache = { release: await findLatest(), at: Date.now() };
        }
        const ours = await currentRelease(country);
        const newer = ours === null || compareReleases(latestCache.release, ours) > 0;
        return { release: latestCache.release, newer, error: null };
      } catch (err) {
        return {
          release: null,
          newer: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async overtureReport(country) {
      return overtureMappingReport(db, country);
    },

    async requestOvertureRefresh(country, adminId) {
      return requestRefresh(db, country, adminId);
    },
  };
}
