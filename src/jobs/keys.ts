import type { Bbox } from '../geonames/build';
import { normalizeBusinessName } from '../cleaning/name';
export const OFFICIAL_GOOGLE_BASE_URL = 'https://places.googleapis.com';
/** Separate quota counter for the mock, so development never uses the real allowance. */
export const MOCK_QUOTA_PROVIDER = 'google_places_mock';
/** Mock search history is stored with this prefix, so it never triggers a real cooldown. */
export const MOCK_TILE_PREFIX = 'mock:';
/** Spec: adaptive split up to depth 2. */
export const MAX_SPLIT_DEPTH = 2;
export const COOLDOWN_NOTE = 'Skipped: the same search ran within the cooldown period';

/** LIVE = real Google; MOCK = local mock server. A worker only runs tasks of its own mode. */
export type RunMode = 'LIVE' | 'MOCK';

/**
 * Stored in job_tasks.tile: the box to search plus the context needed to run the
 * task on its own. (A type alias, not an interface, so it is valid JSON for Prisma.)
 */
export type TaskTile = {
  south: number;
  west: number;
  north: number;
  east: number;
  /** Search area from the planner, e.g. "city:12" or "rural:5". */
  areaKey: string;
  areaKind: 'CITY' | 'RURAL';
  /** Split path inside the area: "" (whole area), "2", "2.0", ... */
  path: string;
  countryCode: string;
  /** Set for city areas; rural places get their city later (Phase 2). */
  cityId: number | null;
  mode: RunMode;
  /** Ignore the cooldown for this job. */
  forceRerun: boolean;
};

export function isOfficialGoogle(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '') === OFFICIAL_GOOGLE_BASE_URL;
}

export function runModeFor(baseUrl: string): RunMode {
  return isOfficialGoogle(baseUrl) ? 'LIVE' : 'MOCK';
}

/** Deterministic key: the same search in the same job can exist only once. */
export function discoveryTaskKey(p: {
  areaKey: string;
  path: string;
  subcategoryId: number;
  keyword: string;
  language: string;
}): string {
  return [
    'discovery',
    'GOOGLE_PLACES',
    p.areaKey,
    `t:${p.path || 'root'}`,
    `sub:${p.subcategoryId}`,
    `kw:${p.keyword}`,
    p.language,
  ].join('|');
}

export function childPath(path: string, index: number): string {
  return path ? `${path}.${index}` : String(index);
}

/** Key used by query_log (cooldown): mode prefix + area + split path. */
export function queryLogTileKey(mode: RunMode, areaKey: string, path: string): string {
  return `${mode === 'MOCK' ? MOCK_TILE_PREFIX : ''}${areaKey}/${path || 'root'}`;
}

export function tileBox(tile: TaskTile): Bbox {
  return { south: tile.south, west: tile.west, north: tile.north, east: tile.east };
}

/** Matching form of a business name (kept here for older imports; see cleaning/name.ts). */
export function normalizeName(name: string): string {
  return normalizeBusinessName(name);
}

/** "https://www.Shop.cy/about" -> "shop.cy"; null when missing or invalid. */
export function websiteDomainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}