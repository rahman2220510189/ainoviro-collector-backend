import type { Pool } from 'pg';
import type { Bbox } from '../geonames/build';
import { describeError, withRetries } from './overture';

/**
 * Foursquare OS Places (spec §6.2), read from the monthly release on Hugging Face
 * (dataset foursquare/fsq-os-places, Apache 2.0). The dataset is gated: the account must
 * accept Foursquare's terms once, and downloads carry a read token (HF_TOKEN in .env).
 *
 * The planet is about 100 files of ~115 MB. For each part of a file (row group) we first
 * read only the small `country` column; the other columns are downloaded only for parts
 * that hold places of the country. Parts whose statistics prove they lie elsewhere are
 * skipped without reading anything.
 */

export const FSQ_DATASET = 'foursquare/fsq-os-places';
const HF = 'https://huggingface.co';
const TREE_URL = `${HF}/api/datasets/${FSQ_DATASET}/tree/main`;

/** One parquet file of a release, with its size (saves a request per file). */
export interface FsqFile {
  url: string;
  size: number | null;
}

/** Hugging Face folder of one release's places (shown in messages). */
export function fsqSource(release: string): string {
  return `hf://datasets/${FSQ_DATASET}/release/dt=${release}/places/parquet/`;
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** A clear message for the answers people actually get. */
function hfError(status: number, what: string): Error {
  if (status === 401) {
    return new Error(
      `Hugging Face refused the token (HTTP 401) while ${what}. Check HF_TOKEN in backend/.env.`,
    );
  }
  if (status === 403) {
    return new Error(
      `Hugging Face says this account has no access (HTTP 403) while ${what}. ` +
        `Open https://huggingface.co/datasets/${FSQ_DATASET} and click "Agree and access repository".`,
    );
  }
  return new Error(`Hugging Face answered HTTP ${status} while ${what}`);
}

/** Every release date ("2026-08-11"), oldest first. */
export async function listFsqReleases(
  token: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const res = await withRetries(() =>
    fetchFn(`${TREE_URL}/release`, { headers: authHeaders(token) }),
  );
  if (!res.ok) throw hfError(res.status, 'listing the Foursquare releases');
  const entries = (await res.json()) as { type?: string; path?: string }[];
  return entries
    .map((e) => /^release\/dt=(\d{4}-\d{2}-\d{2})$/.exec(e.path ?? '')?.[1])
    .filter((d): d is string => d !== undefined)
    .sort();
}

export async function latestFsqRelease(
  token: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const newest = (await listFsqReleases(token, fetchFn)).at(-1);
  if (!newest) throw new Error('No Foursquare release found on Hugging Face');
  return newest;
}

/** The download URLs of every places parquet file of a release. */
export async function listFsqFiles(
  release: string,
  token: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<FsqFile[]> {
  const folder = `release/dt=${release}/places/parquet`;
  const files: FsqFile[] = [];
  let url: string | null = `${TREE_URL}/${folder}`;
  while (url) {
    const page: Response = await withRetries(() =>
      fetchFn(url as string, { headers: authHeaders(token) }),
    );
    if (!page.ok) throw hfError(page.status, `listing the files of release ${release}`);
    const entries = (await page.json()) as { type?: string; path?: string; size?: number }[];
    for (const e of entries) {
      if (e.type === 'file' && e.path?.endsWith('.parquet')) {
        files.push({
          url: `${HF}/datasets/${FSQ_DATASET}/resolve/main/${e.path}`,
          size: typeof e.size === 'number' ? e.size : null,
        });
      }
    }
    // Long folders are paged with a Link header (rel="next").
    const next = /<([^>]+)>;\s*rel="next"/.exec(page.headers.get('link') ?? '');
    url = next?.[1] ?? null;
  }
  if (files.length === 0)
    throw new Error(`No places files found for Foursquare release ${release}`);
  return files;
}

/** One place as it is stored in stg_fsq_places. */
export interface FsqPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  categoryIds: string[];
  categoryLabels: string[];
  website: string | null;
  tel: string | null;
  email: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  postcode: string | null;
  facebookId: string | null;
  instagram: string | null;
  twitter: string | null;
  dateCreated: string | null;
  dateRefreshed: string | null;
  dateClosed: string | null;
}

/** Columns read for the country's parts (geometry and the rest are never downloaded). */
const READ_COLUMNS = [
  'fsq_place_id',
  'name',
  'latitude',
  'longitude',
  'address',
  'locality',
  'region',
  'postcode',
  'country',
  'date_created',
  'date_refreshed',
  'date_closed',
  'tel',
  'website',
  'email',
  'facebook_id',
  'instagram',
  'twitter',
  'fsq_category_ids',
  'fsq_category_labels',
];

/** Places a little outside the stored box (coast, islands) are still kept. */
const BOX_PAD = 0.05;

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return null;
};
const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x.trim() !== '');
/** Dates arrive as "2026-05-01" strings or as Date objects, depending on the release. */
const day = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const t = text(v);
  return t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : t;
};

/**
 * One parquet row in our shape, or null when it is not a usable place of the country:
 * another country, outside the box (wrong coordinates), or no name.
 */
export function toFsqPlace(r: Row, box: Bbox, countryCode: string): FsqPlace | null {
  if (text(r.country)?.toUpperCase() !== countryCode) return null;
  const lat = Number(r.latitude);
  const lng = Number(r.longitude);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < box.south - BOX_PAD ||
    lat > box.north + BOX_PAD ||
    lng < box.west - BOX_PAD ||
    lng > box.east + BOX_PAD
  ) {
    return null;
  }
  const name = text(r.name);
  const id = text(r.fsq_place_id);
  if (!name || !id) return null;
  const email = text(r.email);
  return {
    id,
    name,
    lat,
    lng,
    categoryIds: strings(r.fsq_category_ids),
    categoryLabels: strings(r.fsq_category_labels),
    website: text(r.website),
    tel: text(r.tel),
    email: email ? email.toLowerCase() : null,
    address: text(r.address),
    locality: text(r.locality),
    region: text(r.region),
    postcode: text(r.postcode),
    facebookId: text(r.facebook_id),
    instagram: text(r.instagram),
    twitter: text(r.twitter),
    dateCreated: day(r.date_created),
    dateRefreshed: day(r.date_refreshed),
    dateClosed: day(r.date_closed),
  };
}

/** The oldest "last refreshed" date still kept, e.g. 24 months before today. */
export function refreshedCutoff(maxAgeMonths: number, now = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - maxAgeMonths, now.getUTCDate()),
  );
  return d.toISOString().slice(0, 10);
}

export interface FsqStats {
  read: number;
  kept: number;
  droppedClosed: number;
  droppedOld: number;
  withWebsite: number;
  withEmail: number;
  withPhone: number;
  /** Places of an earlier import that are no longer in this release (deleted). */
  removed: number;
  files: number;
  rowGroupsRead: number;
  rowGroupsSkipped: number;
  /** Most common top-level categories among the kept places. */
  topCategories: { category: string; count: number }[];
}

const isObj = (v: unknown): v is Row => typeof v === 'object' && v !== null;

/** Min/max of a column in a row group, when the file has statistics for it. */
function stat(rowGroup: unknown, path: string, which: 'min' | 'max'): unknown {
  const columns = isObj(rowGroup) && Array.isArray(rowGroup.columns) ? rowGroup.columns : [];
  for (const c of columns) {
    const meta = isObj(c) && isObj(c.meta_data) ? c.meta_data : {};
    const p = Array.isArray(meta.path_in_schema) ? meta.path_in_schema.join('.') : '';
    if (p !== path) continue;
    const st = isObj(meta.statistics) ? meta.statistics : {};
    const v = which === 'min' ? (st.min_value ?? st.min) : (st.max_value ?? st.max);
    return v === undefined || v === null ? null : v;
  }
  return null;
}

/**
 * False only when the statistics prove the row group holds no place of the country:
 * its country range does not include the code, or its coordinates lie outside the box.
 */
export function fsqRowGroupMayHold(rowGroup: unknown, box: Bbox, countryCode: string): boolean {
  const cmin = stat(rowGroup, 'country', 'min');
  const cmax = stat(rowGroup, 'country', 'max');
  if (typeof cmin === 'string' && typeof cmax === 'string') {
    if (countryCode < cmin || countryCode > cmax) return false;
  }
  const num = (v: unknown): number | null => (v === null ? null : Number(v));
  const latMin = num(stat(rowGroup, 'latitude', 'min'));
  const latMax = num(stat(rowGroup, 'latitude', 'max'));
  const lngMin = num(stat(rowGroup, 'longitude', 'min'));
  const lngMax = num(stat(rowGroup, 'longitude', 'max'));
  if (latMin === null || latMax === null || lngMin === null || lngMax === null) return true;
  return !(
    latMax < box.south - BOX_PAD ||
    latMin > box.north + BOX_PAD ||
    lngMax < box.west - BOX_PAD ||
    lngMin > box.east + BOX_PAD
  );
}

type Hyparquet = typeof import('hyparquet');
type AsyncBuffer = Awaited<ReturnType<Hyparquet['asyncBufferFromUrl']>>;

/** fetch that sends the token and retries answers worth retrying (429, 5xx). */
function hfFetch(token: string | null, onRetry: (line: string) => void): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    withRetries(
      async () => {
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(authHeaders(token))) headers.set(k, v);
        // Hugging Face answers with a redirect to its file store; fetch follows it and
        // drops the token for the other host by itself.
        const res = await fetch(input, { ...init, headers, redirect: 'follow' });
        if (res.status === 401 || res.status === 403) throw hfError(res.status, 'downloading');
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        return res;
      },
      { onRetry },
    )) as typeof fetch;
}

/** A remote parquet file whose every byte-range read is retried on network errors. */
async function openRemote(
  hp: Hyparquet,
  file: FsqFile,
  token: string | null,
  onRetry: (line: string) => void,
): Promise<AsyncBuffer> {
  // Hugging Face answers a file URL with a redirect to a signed link on its file store,
  // valid for a while. Asking once per file (not once per byte range) keeps us far below
  // its request limits; the signed link needs no token.
  const resolved = await withRetries(
    async () => {
      const res = await fetch(file.url, {
        method: 'HEAD',
        headers: authHeaders(token),
        redirect: 'manual',
      });
      if (res.status === 401 || res.status === 403) throw hfError(res.status, 'opening a file');
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      return location ? new URL(location, file.url).toString() : null;
    },
    { onRetry },
  );
  const url = resolved ?? file.url;
  const fetchFn = resolved ? undefined : hfFetch(token, onRetry);
  const inner = await withRetries(
    () =>
      hp.asyncBufferFromUrl({
        url,
        fetch: fetchFn ?? retryOnly(onRetry),
        ...(file.size !== null ? { byteLength: file.size } : {}),
      }),
    { onRetry },
  );
  return {
    byteLength: inner.byteLength,
    slice: (start: number, end?: number) =>
      withRetries(() => Promise.resolve(inner.slice(start, end)), { onRetry }),
  };
}

/** fetch for the signed file-store link: no token, retries 429 and 5xx. */
function retryOnly(onRetry: (line: string) => void): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    withRetries(
      async () => {
        const res = await fetch(input, init);
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        return res;
      },
      { onRetry },
    )) as typeof fetch;
}

/**
 * Reads the country's places from Foursquare parquet files (Hugging Face URLs or local
 * paths) in plain JavaScript. Closed places and places not refreshed since `cutoff` are
 * dropped (spec: date_closed IS NULL, date_refreshed within N months).
 */
export async function readFsqPlaces(
  files: (FsqFile | string)[],
  box: Bbox,
  countryCode: string,
  options: { cutoff: string; token?: string | null; onProgress?: (line: string) => void },
): Promise<{ kept: FsqPlace[]; stats: Omit<FsqStats, 'removed'> }> {
  const say = options.onProgress ?? (() => undefined);
  const hp = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const all: FsqPlace[] = [];
  let groupsRead = 0;
  let groupsSkipped = 0;

  for (const [i, entry] of files.entries()) {
    const f: FsqFile = typeof entry === 'string' ? { url: entry, size: null } : entry;
    const file = /^https?:\/\//.test(f.url)
      ? hp.cachedAsyncBuffer(await openRemote(hp, f, options.token ?? null, say))
      : await hp.asyncBufferFromFile(f.url);
    const metadata = await hp.parquetMetadataAsync(file);
    let rowStart = 0;
    let found = 0;
    for (const group of metadata.row_groups) {
      const rowEnd = rowStart + Number(group.num_rows);
      if (!fsqRowGroupMayHold(group, box, countryCode)) {
        groupsSkipped += 1;
        rowStart = rowEnd;
        continue;
      }
      // First only the country column: most parts of the planet hold none of ours.
      const countries = await hp.parquetReadObjects({
        file,
        metadata,
        compressors,
        columns: ['country'],
        rowStart,
        rowEnd,
      });
      let first = -1;
      let last = -1;
      countries.forEach((r, idx) => {
        if (text((r as Row).country)?.toUpperCase() === countryCode) {
          if (first < 0) first = idx;
          last = idx;
        }
      });
      if (first < 0) {
        groupsSkipped += 1;
        rowStart = rowEnd;
        continue;
      }
      groupsRead += 1;
      const rows = await hp.parquetReadObjects({
        file,
        metadata,
        compressors,
        columns: READ_COLUMNS,
        rowStart: rowStart + first,
        rowEnd: rowStart + last + 1,
      });
      for (const r of rows) {
        const place = toFsqPlace(r as Row, box, countryCode);
        if (place) {
          all.push(place);
          found += 1;
        }
      }
      rowStart = rowEnd;
    }
    say(`  file ${i + 1}/${files.length}: ${found} places in the country`);
  }

  let closed = 0;
  let old = 0;
  const kept: FsqPlace[] = [];
  for (const p of all) {
    if (p.dateClosed) closed += 1;
    else if (!p.dateRefreshed || p.dateRefreshed < options.cutoff) old += 1;
    else kept.push(p);
  }
  const counts = new Map<string, number>();
  for (const p of kept) {
    const top = p.categoryLabels[0]?.split(' > ')[0] ?? '(none)';
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return {
    kept,
    stats: {
      read: all.length,
      kept: kept.length,
      droppedClosed: closed,
      droppedOld: old,
      withWebsite: kept.filter((p) => p.website).length,
      withEmail: kept.filter((p) => p.email).length,
      withPhone: kept.filter((p) => p.tel).length,
      files: files.length,
      rowGroupsRead: groupsRead,
      rowGroupsSkipped: groupsSkipped,
      topCategories: [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([category, count]) => ({ category, count })),
    },
  };
}

const COLUMNS = [
  'id',
  'name',
  'lat',
  'lng',
  'category_ids',
  'category_labels',
  'website',
  'tel',
  'email',
  'address',
  'locality',
  'region',
  'postcode',
  'facebook_id',
  'instagram',
  'twitter',
  'date_created',
  'date_refreshed',
] as const;
const ARRAY_COLUMNS = new Set(['category_ids', 'category_labels']);
const TYPES: Record<string, string> = { lat: 'float8', lng: 'float8' };

const valueOf = (p: FsqPlace, column: (typeof COLUMNS)[number]): unknown =>
  ({
    id: p.id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    category_ids: p.categoryIds,
    category_labels: p.categoryLabels,
    website: p.website,
    tel: p.tel,
    email: p.email,
    address: p.address,
    locality: p.locality,
    region: p.region,
    postcode: p.postcode,
    facebook_id: p.facebookId,
    instagram: p.instagram,
    twitter: p.twitter,
    date_created: p.dateCreated,
    date_refreshed: p.dateRefreshed,
  })[column];

/**
 * Replaces the country's staging rows with this release in ONE transaction (upsert, then
 * delete rows of the country that are not in this release). A failed import changes nothing.
 */
export async function writeFsqPlaces(
  db: Pool,
  places: FsqPlace[],
  countryCode: string,
  release: string,
  batchSize = 1000,
): Promise<{ removed: number }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const select = COLUMNS.map((c) =>
      ARRAY_COLUMNS.has(c)
        ? `ARRAY(SELECT jsonb_array_elements_text(x->'${c}'))`
        : `(x->>'${c}')::${TYPES[c] ?? 'text'}`,
    ).join(', ');
    for (let start = 0; start < places.length; start += batchSize) {
      const rows = places
        .slice(start, start + batchSize)
        .map((p) => Object.fromEntries(COLUMNS.map((c) => [c, valueOf(p, c)])));
      await client.query(
        `INSERT INTO stg_fsq_places (${COLUMNS.join(', ')}, country_code, release, imported_at)
         SELECT ${select}, $2, $3, now() FROM jsonb_array_elements($1::jsonb) AS x
         ON CONFLICT (id) DO UPDATE SET
           ${COLUMNS.filter((c) => c !== 'id')
             .map((c) => `${c} = EXCLUDED.${c}`)
             .join(', ')},
           country_code = EXCLUDED.country_code, release = EXCLUDED.release,
           imported_at = EXCLUDED.imported_at`,
        [JSON.stringify(rows), countryCode, release],
      );
    }
    const removed = await client.query(
      'DELETE FROM stg_fsq_places WHERE country_code = $1 AND release <> $2',
      [countryCode, release],
    );
    await client.query('COMMIT');
    return { removed: removed.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(describeError(err), { cause: err });
  } finally {
    client.release();
  }
}
