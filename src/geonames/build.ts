import type { CityRadius, CountryConfig } from './config';
import type { AdminCode, CountryInfo, GeonameRow } from './parse';

export type LocationKind = 'COUNTRY' | 'REGION' | 'CITY';

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** A location ready to be written; parents are referenced by GeoNames id. */
export interface LocationDraft {
  geonamesId: number;
  parentGeonamesId: number | null;
  type: LocationKind;
  name: string;
  nameLocal: string | null;
  countryCode: string;
  lat: number | null;
  lng: number | null;
  bbox: Bbox | null;
  population: number | null;
}

export interface BuildStats {
  skippedNotPopulated: number;
  skippedExcludedCodes: number;
  skippedNoCoordinates: number;
}

export interface LocationTreeDraft {
  country: LocationDraft;
  /** Ordered parents-first (admin1 before admin2). */
  regions: LocationDraft[];
  cities: LocationDraft[];
  stats: BuildStats;
}

export interface BuildInput {
  countryCode: string;
  countryInfo: CountryInfo;
  admin1: Map<string, AdminCode>;
  /** Only used when config.useAdmin2 is true. */
  admin2: Map<string, AdminCode> | null;
  rows: GeonameRow[];
  config: CountryConfig;
}

/**
 * Populated-place codes we skip: sections of a city (PPLX), historical (PPLH, PPLCH),
 * abandoned (PPLQ) and destroyed (PPLW) places. Searching those wastes requests.
 */
export const EXCLUDED_PLACE_CODES = new Set(['PPLX', 'PPLH', 'PPLCH', 'PPLQ', 'PPLW']);

const KM_PER_DEGREE_LAT = 111.32;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Approximate square box around a city centre. GeoNames dumps have no city
 * boundaries, so the size is derived from population (see seed/countries.json).
 */
export function cityBbox(lat: number, lng: number, population: number, radius: CityRadius): Bbox {
  const raw = radius.kmPerSqrtPopulation * Math.sqrt(Math.max(population, 0));
  const halfKm = Math.min(Math.max(raw, radius.minKm), radius.maxKm);
  const dLat = halfKm / KM_PER_DEGREE_LAT;
  const dLng = halfKm / (KM_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  return {
    south: round6(lat - dLat),
    west: round6(lng - dLng),
    north: round6(lat + dLat),
    east: round6(lng + dLng),
  };
}

export function unionBbox(a: Bbox | null, b: Bbox): Bbox {
  if (!a) return { ...b };
  return {
    south: Math.min(a.south, b.south),
    west: Math.min(a.west, b.west),
    north: Math.max(a.north, b.north),
    east: Math.max(a.east, b.east),
  };
}

/** First alternate name written in the given Unicode script (e.g. "Greek"), or null. */
export function pickLocalName(alternateNames: string[], script: string | undefined): string | null {
  if (!script) return null;
  const pattern = new RegExp(`\\p{Script=${script}}`, 'u');
  return alternateNames.find((name) => pattern.test(name)) ?? null;
}

/** Builds the country -> region(s) -> city tree from parsed GeoNames data. */
export function buildLocationTree(input: BuildInput): LocationTreeDraft {
  const { countryCode, countryInfo, admin1, admin2, rows, config } = input;
  const rowsById = new Map(rows.map((r) => [r.geonameId, r]));
  const stats: BuildStats = { skippedNotPopulated: 0, skippedExcludedCodes: 0, skippedNoCoordinates: 0 };

  const countryRow = rowsById.get(countryInfo.geonameId);
  const country: LocationDraft = {
    geonamesId: countryInfo.geonameId,
    parentGeonamesId: null,
    type: 'COUNTRY',
    name: countryInfo.name,
    nameLocal: pickLocalName(countryRow?.alternateNames ?? [], config.localScript),
    countryCode,
    lat: countryRow?.lat ?? null,
    lng: countryRow?.lng ?? null,
    bbox: null,
    population: countryInfo.population || null,
  };

  const regionDraft = (code: AdminCode, parentGeonamesId: number): LocationDraft => {
    const row = rowsById.get(code.geonameId);
    return {
      geonamesId: code.geonameId,
      parentGeonamesId,
      type: 'REGION',
      name: code.name,
      nameLocal: pickLocalName(row?.alternateNames ?? [], config.localScript),
      countryCode,
      lat: row?.lat ?? null,
      lng: row?.lng ?? null,
      bbox: null,
      population: row?.population || null,
    };
  };

  // Level 1: admin1 regions.
  const regions: LocationDraft[] = [];
  const admin1Ids = new Map<string, number>();
  for (const [code, entry] of admin1) {
    regions.push(regionDraft(entry, country.geonamesId));
    admin1Ids.set(code, entry.geonameId);
  }

  // Level 2 (optional): admin2 regions under their admin1.
  const admin2Ids = new Map<string, number>();
  if (config.useAdmin2 && admin2) {
    for (const [code, entry] of admin2) {
      const parentAdmin1 = admin1Ids.get(code.split('.')[0] ?? '');
      regions.push(regionDraft(entry, parentAdmin1 ?? country.geonamesId));
      admin2Ids.set(code, entry.geonameId);
    }
  }

  // Cities: populated places, attached to the deepest known admin level.
  const cities: LocationDraft[] = [];
  for (const row of rows) {
    if (row.featureClass !== 'P') {
      stats.skippedNotPopulated += 1;
      continue;
    }
    if (EXCLUDED_PLACE_CODES.has(row.featureCode)) {
      stats.skippedExcludedCodes += 1;
      continue;
    }
    if (row.lat === null || row.lng === null) {
      stats.skippedNoCoordinates += 1;
      continue;
    }

    const parentGeonamesId =
      (config.useAdmin2 ? admin2Ids.get(`${row.admin1Code}.${row.admin2Code}`) : undefined) ??
      admin1Ids.get(row.admin1Code) ??
      country.geonamesId;

    cities.push({
      geonamesId: row.geonameId,
      parentGeonamesId,
      type: 'CITY',
      name: row.name,
      nameLocal: pickLocalName(row.alternateNames, config.localScript),
      countryCode,
      lat: row.lat,
      lng: row.lng,
      bbox: cityBbox(row.lat, row.lng, row.population, config.cityRadius),
      population: row.population || null,
    });
  }

  // Region and country boxes = union of all city boxes beneath them.
  const byId = new Map<number, LocationDraft>([
    [country.geonamesId, country],
    ...regions.map((r) => [r.geonamesId, r] as const),
  ]);
  for (const city of cities) {
    let parentId = city.parentGeonamesId;
    while (parentId !== null && city.bbox) {
      const parent = byId.get(parentId);
      if (!parent) break;
      parent.bbox = unionBbox(parent.bbox, city.bbox);
      parentId = parent.parentGeonamesId;
    }
  }

  return { country, regions, cities, stats };
}