import type { Pool } from 'pg';
import type { Bbox } from '../geonames/build';
import type { CountryBorder } from './country-border';
import { hasUsefulContact } from './storage';

/**
 * Overture Maps places (spec §6.2), read straight from the public release on S3.
 * Only the row groups inside the country's box are downloaded, so a small country costs
 * megabytes, not the whole planet. Schema v2 (release 2026-09-23 and later):
 * `taxonomy` + `basic_category` replaced `categories`.
 */

export const OVERTURE_BUCKET = 'overturemaps-us-west-2';
const LIST_URL = `https://${OVERTURE_BUCKET}.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/`;

const BUCKET_URL = `https://${OVERTURE_BUCKET}.s3.us-west-2.amazonaws.com`;

/** "fetch failed" alone says little; add the network reason (ECONNRESET, ETIMEDOUT, ...). */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code ?? cause?.message;
  return why && !err.message.includes(why) ? `${err.message} (${why})` : err.message;
}

/**
 * Runs a network step again after short pauses (1, 2, 4, 8 s) when it fails: a long
 * download over home internet loses the connection now and then.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; baseMs?: number; onRetry?: (line: string) => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseMs = options.baseMs ?? 1000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      const wait = baseMs * 2 ** (attempt - 1);
      options.onRetry?.(
        `  network problem (${describeError(err)}), trying again in ${wait / 1000} s`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** fetch that also retries answers worth retrying (429, 5xx). */
function retryingFetch(onRetry?: (line: string) => void): typeof fetch {
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

/** S3 folder of one release's places (shown in messages). */
export function overtureSource(release: string): string {
  return `s3://${OVERTURE_BUCKET}/release/${release}/theme=places/type=place/`;
}

/** The https URLs of every places parquet file of a release (anonymous S3 listing, paged). */
export async function listOvertureFiles(
  release: string,
  fetchFn: typeof fetch = fetch,
  /** Another part of the release, e.g. "theme=divisions/type=division_area". */
  part = 'theme=places/type=place',
): Promise<string[]> {
  const prefix = `release/${release}/${part}/`;
  const urls: string[] = [];
  let token: string | null = null;
  do {
    const query = new URLSearchParams({ 'list-type': '2', prefix });
    if (token) query.set('continuation-token', token);
    const res = await withRetries(() => fetchFn(`${BUCKET_URL}/?${query.toString()}`));
    if (!res.ok) throw new Error(`Overture file list answered HTTP ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+\.parquet)<\/Key>/g))
      urls.push(`${BUCKET_URL}/${m[1]}`);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null)
      : null;
  } while (token);
  if (urls.length === 0) throw new Error(`No ${part} files found for Overture release ${release}`);
  return urls;
}

/** Newest release folder on S3, e.g. "2026-09-23.1" (anonymous S3 listing). */
export async function latestOvertureRelease(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await withRetries(() => fetchFn(LIST_URL));
  if (!res.ok) throw new Error(`Overture release list answered HTTP ${res.status}`);
  const xml = await res.text();
  const releases = [...xml.matchAll(/<Prefix>release\/(\d{4}-\d{2}-\d{2}\.\d+)\/<\/Prefix>/g)]
    .map((m) => m[1] as string)
    .sort(compareReleases);
  const newest = releases.at(-1);
  if (!newest) throw new Error('No Overture release found on S3');
  return newest;
}

/** "2026-09-23.10" sorts after "2026-09-23.9". */
export function compareReleases(a: string, b: string): number {
  const [da = '', na = '0'] = a.split('.');
  const [db = '', nb = '0'] = b.split('.');
  return da === db ? Number(na) - Number(nb) : da < db ? -1 : 1;
}

/** One place as it is stored in stg_overture_places. */
export interface OverturePlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  basicCategory: string | null;
  taxonomyPrimary: string | null;
  taxonomyHierarchy: string[];
  taxonomyAlternates: string[];
  confidence: number | null;
  operatingStatus: string | null;
  websites: string[];
  phones: string[];
  emails: string[];
  socials: string[];
  brandName: string | null;
  address: string | null;
  locality: string | null;
  postcode: string | null;
  region: string | null;
  datasets: string[];
}

/** Closed places are never imported; open and unknown status are kept (most have none). */
export const CLOSED_STATUSES = ['permanently_closed', 'temporarily_closed', 'closed'];

/** The top-level columns we read (the rest of the file is never downloaded). */
const READ_COLUMNS = [
  'id',
  'bbox',
  'names',
  'basic_category',
  'taxonomy',
  'confidence',
  'operating_status',
  'websites',
  'phones',
  'emails',
  'socials',
  'brand',
  'addresses',
  'sources',
];

/** Places a little outside the stored box (coast, islands) are still read. */
const BOX_PAD = 0.05;

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => (v && typeof v === 'object' ? (v as Row) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] =>
  list(v).filter((x): x is string => typeof x === 'string' && x.trim() !== '');
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Turns one parquet row (nested objects, as hyparquet returns them) into our shape, or
 * null when it is not in the country: outside the box, another address country, no name.
 */
export function toOverturePlace(r: Row, box: Bbox, countryCode: string): OverturePlace | null {
  const b = obj(r.bbox);
  const lat = (Number(b.ymin) + Number(b.ymax)) / 2;
  const lng = (Number(b.xmin) + Number(b.xmax)) / 2;
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
  const address = obj(list(r.addresses)[0]);
  const country = text(address.country);
  if (country && country.toUpperCase() !== countryCode) return null;
  const name = text(obj(r.names).primary);
  if (!name) return null;

  const taxonomy = obj(r.taxonomy);
  const datasets = [
    ...new Set(
      list(r.sources)
        .map((s) => text(obj(s).dataset))
        .filter((d) => d !== null),
    ),
  ] as string[];
  const confidence =
    r.confidence === null || r.confidence === undefined ? null : Number(r.confidence);
  return {
    id: String(r.id),
    name: name.trim(),
    lat,
    lng,
    basicCategory: text(r.basic_category),
    taxonomyPrimary: text(taxonomy.primary),
    taxonomyHierarchy: strings(taxonomy.hierarchy),
    taxonomyAlternates: strings(taxonomy.alternates),
    confidence,
    operatingStatus: text(r.operating_status),
    websites: strings(r.websites),
    phones: strings(r.phones),
    emails: strings(r.emails).map((e) => e.trim().toLowerCase()),
    socials: strings(r.socials),
    brandName: text(obj(obj(r.brand).names).primary),
    address: text(address.freeform),
    locality: text(address.locality),
    postcode: text(address.postcode),
    region: text(address.region),
    datasets,
  };
}

/** The place's first address names a country (then that country decides, not the outline). */
export function hasAddressCountry(r: Row): boolean {
  return text(obj(list(r.addresses)[0]).country) !== null;
}

export interface OvertureStats {
  read: number;
  kept: number;
  droppedLowConfidence: number;
  droppedClosed: number;
  /** No email and no own website (when onlyWithContact is on). */
  droppedNoContact: number;
  /** In the box but outside the country's real outline, with no address country. */
  droppedOutsideBorder: number;
  /** Whether the country's outline was used (false: box only). */
  borderUsed: boolean;
  withWebsite: number;
  withEmail: number;
  withPhone: number;
  /** Places of an earlier import that are no longer in this release (deleted). */
  removed: number;
  /** Parquet files opened, and row groups downloaded vs skipped (outside the box). */
  files: number;
  rowGroupsRead: number;
  rowGroupsSkipped: number;
  /** Most common primary categories among the kept places. */
  topCategories: { category: string; count: number }[];
}

/** Min/max of one column in a row group, when the file has statistics for it. */
function stat(rowGroup: unknown, path: string, which: 'min' | 'max'): number | null {
  for (const c of list(obj(rowGroup).columns)) {
    const meta = obj(obj(c).meta_data);
    if (strings(meta.path_in_schema).join('.') !== path) continue;
    const st = obj(meta.statistics);
    const v = which === 'min' ? (st.min_value ?? st.min) : (st.max_value ?? st.max);
    return v === undefined || v === null ? null : Number(v);
  }
  return null;
}

/** False only when the statistics prove the whole row group lies outside the box. */
export function rowGroupMayOverlap(rowGroup: unknown, box: Bbox): boolean {
  const xmin = stat(rowGroup, 'bbox.xmin', 'min');
  const xmax = stat(rowGroup, 'bbox.xmax', 'max');
  const ymin = stat(rowGroup, 'bbox.ymin', 'min');
  const ymax = stat(rowGroup, 'bbox.ymax', 'max');
  if (xmin === null || xmax === null || ymin === null || ymax === null) return true;
  return !(
    xmax < box.west - BOX_PAD ||
    xmin > box.east + BOX_PAD ||
    ymax < box.south - BOX_PAD ||
    ymin > box.north + BOX_PAD
  );
}

type Hyparquet = typeof import('hyparquet');
type AsyncBuffer = Awaited<ReturnType<Hyparquet['asyncBufferFromUrl']>>;

/** A remote parquet file whose every byte-range read is retried on network errors. */
export async function openUrlWithRetries(
  hp: Hyparquet,
  url: string,
  onRetry: (line: string) => void,
): Promise<AsyncBuffer> {
  const inner = await withRetries(
    () => hp.asyncBufferFromUrl({ url, fetch: retryingFetch(onRetry) }),
    { onRetry },
  );
  return {
    byteLength: inner.byteLength,
    slice: (start: number, end?: number) =>
      withRetries(() => Promise.resolve(inner.slice(start, end)), { onRetry }),
  };
}

/**
 * Reads the country's places from Overture parquet files (https URLs or local paths)
 * in plain JavaScript (hyparquet): only the file footers and the row groups that can
 * touch the box are downloaded. No native module, so it runs on locked-down Windows too.
 */
export async function readOverturePlaces(
  files: string[],
  box: Bbox,
  countryCode: string,
  minConfidence: number,
  onProgress: (line: string) => void = () => undefined,
  onlyWithContact = false,
  /** The country's real outline; null = the box only. */
  border: CountryBorder | null = null,
): Promise<{ kept: OverturePlace[]; stats: Omit<OvertureStats, 'removed'> }> {
  const hp = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const all: OverturePlace[] = [];
  let groupsRead = 0;
  let groupsSkipped = 0;
  let outsideBorder = 0;

  for (const [i, location] of files.entries()) {
    const file = /^https?:\/\//.test(location)
      ? hp.cachedAsyncBuffer(await openUrlWithRetries(hp, location, onProgress))
      : await hp.asyncBufferFromFile(location);
    const metadata = await hp.parquetMetadataAsync(file);
    let rowStart = 0;
    let found = 0;
    for (const group of metadata.row_groups) {
      const rowEnd = rowStart + Number(group.num_rows);
      if (rowGroupMayOverlap(group, box)) {
        groupsRead += 1;
        const rows = await hp.parquetReadObjects({
          file,
          metadata,
          compressors,
          columns: READ_COLUMNS,
          rowStart,
          rowEnd,
        });
        for (const r of rows) {
          const place = toOverturePlace(r as Row, box, countryCode);
          // No address country: only the real outline can tell Greece from Turkey.
          if (
            place &&
            border &&
            !hasAddressCountry(r as Row) &&
            !border.contains(place.lng, place.lat)
          ) {
            outsideBorder += 1;
            continue;
          }
          if (place) {
            all.push(place);
            found += 1;
          }
        }
      } else {
        groupsSkipped += 1;
      }
      rowStart = rowEnd;
    }
    onProgress(`  file ${i + 1}/${files.length}: ${found} places in the country`);
  }

  let lowConfidence = 0;
  let closed = 0;
  let noContact = 0;
  const kept: OverturePlace[] = [];
  for (const p of all) {
    if (p.operatingStatus && CLOSED_STATUSES.includes(p.operatingStatus)) closed += 1;
    else if (p.confidence !== null && p.confidence < minConfidence) lowConfidence += 1;
    else if (onlyWithContact && !hasUsefulContact(p.emails, p.websites)) noContact += 1;
    else kept.push(p);
  }
  const counts = new Map<string, number>();
  for (const p of kept) {
    const c = p.taxonomyPrimary ?? '(none)';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return {
    kept,
    stats: {
      read: all.length,
      kept: kept.length,
      droppedLowConfidence: lowConfidence,
      droppedClosed: closed,
      droppedNoContact: noContact,
      droppedOutsideBorder: outsideBorder,
      borderUsed: border !== null,
      withWebsite: kept.filter((p) => p.websites.length > 0).length,
      withEmail: kept.filter((p) => p.emails.length > 0).length,
      withPhone: kept.filter((p) => p.phones.length > 0).length,
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
  'basic_category',
  'taxonomy_primary',
  'taxonomy_hierarchy',
  'taxonomy_alternates',
  'confidence',
  'operating_status',
  'websites',
  'phones',
  'emails',
  'socials',
  'brand_name',
  'address',
  'locality',
  'postcode',
  'region',
  'datasets',
] as const;
const ARRAY_COLUMNS = new Set([
  'taxonomy_hierarchy',
  'taxonomy_alternates',
  'websites',
  'phones',
  'emails',
  'socials',
  'datasets',
]);
const TYPES: Record<string, string> = {
  id: 'text',
  name: 'text',
  lat: 'float8',
  lng: 'float8',
  confidence: 'float8',
};

const valueOf = (p: OverturePlace, column: (typeof COLUMNS)[number]): unknown =>
  ({
    id: p.id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    basic_category: p.basicCategory,
    taxonomy_primary: p.taxonomyPrimary,
    taxonomy_hierarchy: p.taxonomyHierarchy,
    taxonomy_alternates: p.taxonomyAlternates,
    confidence: p.confidence,
    operating_status: p.operatingStatus,
    websites: p.websites,
    phones: p.phones,
    emails: p.emails,
    socials: p.socials,
    brand_name: p.brandName,
    address: p.address,
    locality: p.locality,
    postcode: p.postcode,
    region: p.region,
    datasets: p.datasets,
  })[column];

/**
 * Replaces the country's staging rows with this release in ONE transaction: upsert every
 * kept place, then delete rows of the country that are not in this release. A failed
 * import leaves the previous data untouched.
 */
export async function writeOverturePlaces(
  db: Pool,
  places: OverturePlace[],
  countryCode: string,
  release: string,
  batchSize = 1000,
): Promise<{ removed: number }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // A batch arrives as one JSON array of rows; list columns are JSON arrays inside it.
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
        `INSERT INTO stg_overture_places (${COLUMNS.join(', ')}, country_code, release, imported_at)
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
      'DELETE FROM stg_overture_places WHERE country_code = $1 AND release <> $2',
      [countryCode, release],
    );
    await client.query('COMMIT');
    return { removed: removed.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
