import type { Bbox } from '../geonames/build';

/**
 * The real outline of a country (step 6.4). A country's box is a rectangle: Greece's box
 * also covers the west of Turkey, the south of Albania, North Macedonia and Bulgaria.
 * Places whose address names another country are dropped already; places with NO address
 * country are tested against the outline from Overture's own "divisions" data
 * (division_area, subtype = country), land and territorial sea, so harbour and beach
 * places just off the coastline stay in.
 */

type Ring = number[][];
type PolygonCoords = Ring[];

interface Feature {
  bbox: Bbox;
  /** Horizontal bands; each holds the edges (x1, y1, x2, y2) that cross it. */
  bands: Float64Array[];
  bandHeight: number;
}

export interface CountryBorder {
  countryCode: string;
  /** How many areas (land, sea) make up the outline. */
  areas: number;
  /** Corner points in the outline (a measure of its detail). */
  points: number;
  contains(lng: number, lat: number): boolean;
}

/** GeoJSON geometry as hyparquet returns it. */
export type BorderGeometry =
  | { type: 'Polygon'; coordinates: PolygonCoords }
  | { type: 'MultiPolygon'; coordinates: PolygonCoords[] }
  | { type: string; coordinates?: unknown };

/** About 1 km per band: a point is tested against a few hundred edges, not all of them. */
const BAND_DEGREES = 0.01;

function buildFeature(polygons: PolygonCoords[]): { feature: Feature; points: number } | null {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  let points = 0;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [x, y] of ring as [number, number][]) {
        if (y < south) south = y;
        if (y > north) north = y;
        if (x < west) west = x;
        if (x > east) east = x;
        points += 1;
      }
    }
  }
  if (points === 0) return null;
  const count = Math.max(1, Math.ceil((north - south) / BAND_DEGREES));
  const bandHeight = (north - south) / count || 1;
  const lists: number[][] = Array.from({ length: count }, () => []);
  const bandOf = (y: number): number =>
    Math.min(count - 1, Math.max(0, Math.floor((y - south) / bandHeight)));
  for (const rings of polygons) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [x1, y1] = ring[i] as [number, number];
        const [x2, y2] = ring[i + 1] as [number, number];
        if (y1 === y2) continue; // horizontal edges never cross a horizontal ray
        const from = bandOf(Math.min(y1, y2));
        const to = bandOf(Math.max(y1, y2));
        for (let b = from; b <= to; b += 1) lists[b]?.push(x1, y1, x2, y2);
      }
    }
  }
  return {
    feature: {
      bbox: { south, north, west, east },
      bands: lists.map((l) => Float64Array.from(l)),
      bandHeight,
    },
    points,
  };
}

/** Even-odd ray test inside one area (holes, lakes and islands handled by the rule). */
function insideFeature(f: Feature, x: number, y: number): boolean {
  const { bbox } = f;
  if (x < bbox.west || x > bbox.east || y < bbox.south || y > bbox.north) return false;
  const band = f.bands[Math.min(f.bands.length - 1, Math.floor((y - bbox.south) / f.bandHeight))];
  if (!band) return false;
  let inside = false;
  for (let i = 0; i < band.length; i += 4) {
    const x1 = band[i] as number;
    const y1 = band[i + 1] as number;
    const x2 = band[i + 2] as number;
    const y2 = band[i + 3] as number;
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

/** Builds the outline from the country's areas (Polygon or MultiPolygon each). */
export function buildCountryBorder(
  countryCode: string,
  geometries: BorderGeometry[],
): CountryBorder {
  const features: Feature[] = [];
  let points = 0;
  for (const g of geometries) {
    const polygons =
      g.type === 'Polygon'
        ? [g.coordinates as PolygonCoords]
        : g.type === 'MultiPolygon'
          ? (g.coordinates as PolygonCoords[])
          : [];
    const built = buildFeature(polygons);
    if (built) {
      features.push(built.feature);
      points += built.points;
    }
  }
  return {
    countryCode,
    areas: features.length,
    points,
    contains: (lng, lat) => features.some((f) => insideFeature(f, lng, lat)),
  };
}

type Row = Record<string, unknown>;
type Hyparquet = typeof import('hyparquet');
type AsyncBuffer = Awaited<ReturnType<Hyparquet['asyncBufferFromUrl']>>;

/** Min/max of a bbox column in a row group (null when the file has no statistics). */
function groupBox(rowGroup: unknown): Bbox | null {
  const v: Record<string, number> = {};
  for (const c of ((rowGroup as Row).columns as Row[] | undefined) ?? []) {
    const meta = (c.meta_data ?? {}) as Row;
    const path = ((meta.path_in_schema as string[] | undefined) ?? []).join('.');
    const st = (meta.statistics ?? {}) as Row;
    const min = st.min_value ?? st.min;
    const max = st.max_value ?? st.max;
    if (path === 'bbox.xmin' && min !== undefined) v.west = Number(min);
    if (path === 'bbox.xmax' && max !== undefined) v.east = Number(max);
    if (path === 'bbox.ymin' && min !== undefined) v.south = Number(min);
    if (path === 'bbox.ymax' && max !== undefined) v.north = Number(max);
  }
  return v.west === undefined ||
    v.east === undefined ||
    v.south === undefined ||
    v.north === undefined
    ? null
    : { west: v.west, east: v.east, south: v.south, north: v.north };
}

/**
 * Reads the country's outline from Overture division_area files (https URLs or local
 * paths). Cheap: per row group touching the box only two short text columns are read
 * first; the shape itself is read only for the rows of this country.
 * Returns null when the files hold no outline for the country.
 */
export async function readCountryBorder(
  files: string[],
  box: Bbox,
  countryCode: string,
  options: {
    onProgress?: (line: string) => void;
    /** Opens a remote file (with retries); local paths are opened directly. */
    openUrl?: (hp: Hyparquet, url: string) => Promise<AsyncBuffer>;
  } = {},
): Promise<CountryBorder | null> {
  const hp = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const geometries: BorderGeometry[] = [];
  for (const location of files) {
    const remote = /^https?:\/\//.test(location);
    const file = remote
      ? hp.cachedAsyncBuffer(
          options.openUrl
            ? await options.openUrl(hp, location)
            : await hp.asyncBufferFromUrl({ url: location }),
        )
      : await hp.asyncBufferFromFile(location);
    const metadata = await hp.parquetMetadataAsync(file);
    let rowStart = 0;
    for (const group of metadata.row_groups) {
      const rowEnd = rowStart + Number(group.num_rows);
      const gb = groupBox(group);
      const overlaps =
        !gb ||
        !(gb.east < box.west || gb.west > box.east || gb.north < box.south || gb.south > box.north);
      if (overlaps) {
        const keys = await hp.parquetReadObjects({
          file,
          metadata,
          compressors,
          columns: ['country', 'subtype'],
          rowStart,
          rowEnd,
        });
        for (const [i, k] of keys.entries()) {
          const row = k as Row;
          if (row.subtype !== 'country' || String(row.country).toUpperCase() !== countryCode) {
            continue;
          }
          const [shape] = await hp.parquetReadObjects({
            file,
            metadata,
            compressors,
            columns: ['geometry'],
            rowStart: rowStart + i,
            rowEnd: rowStart + i + 1,
          });
          let geometry = (shape as Row | undefined)?.geometry;
          // A file without GeoParquet metadata gives the raw WKB bytes: decode them here.
          if (geometry instanceof Uint8Array) {
            const { wkbToGeojson } = await import('hyparquet/src/wkb.js');
            geometry = wkbToGeojson({
              view: new DataView(geometry.buffer, geometry.byteOffset, geometry.byteLength),
              offset: 0,
            });
          }
          if (geometry && typeof geometry === 'object') {
            geometries.push(geometry as BorderGeometry);
          }
        }
      }
      rowStart = rowEnd;
    }
  }
  if (geometries.length === 0) return null;
  const border = buildCountryBorder(countryCode, geometries);
  options.onProgress?.(
    `  country outline: ${border.areas} area(s), ${border.points.toLocaleString('en')} points`,
  );
  return border.areas > 0 ? border : null;
}
