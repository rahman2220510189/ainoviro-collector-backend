import type { Pool } from 'pg';
import type { Bbox } from '../geonames/build';

export interface CityRecord {
  id: number;
  name: string;
  lat: number;
  lng: number;
  population: number | null;
  bbox: Bbox | null;
}

export type CityMethod = 'CITY_AREA' | 'NEAREST' | 'FALLBACK';

export interface CityMatch {
  cityId: number;
  cityName: string;
  method: CityMethod;
}

export interface CityResolverOptions {
  /** Towns at or above this population "own" their search box (same rule as the planner). */
  minCityPopulation: number;
  /** A small place further away than this is not used. */
  maxNearestKm: number;
}

export const DEFAULT_NEAREST_CITY_KM = 8;

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function contains(box: Bbox, lat: number, lng: number): boolean {
  return lat >= box.south && lat <= box.north && lng >= box.west && lng <= box.east;
}

/**
 * Decides a place's city from its coordinates (never a country name or "unknown"):
 *  1. inside the box of a town with population >= minCityPopulation -> the LARGEST such
 *     town (suburbs like Germasogeia become "Limassol", exactly like the search planner);
 *  2. otherwise the nearest populated place within maxNearestKm (villages);
 *  3. otherwise the fallback city (the search area's city), if any.
 */
export class CityResolver {
  private readonly bigTowns: CityRecord[];
  private readonly byId: Map<number, CityRecord>;

  constructor(
    private readonly cities: CityRecord[],
    private readonly options: CityResolverOptions,
  ) {
    this.bigTowns = cities
      .filter((c) => c.bbox !== null && (c.population ?? 0) >= options.minCityPopulation)
      .sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
    this.byId = new Map(cities.map((c) => [c.id, c]));
  }

  get size(): number {
    return this.cities.length;
  }

  resolve(
    lat: number | null,
    lng: number | null,
    fallbackCityId: number | null = null,
  ): CityMatch | null {
    if (lat !== null && lng !== null) {
      const town = this.bigTowns.find((c) => c.bbox && contains(c.bbox, lat, lng));
      if (town) return { cityId: town.id, cityName: town.name, method: 'CITY_AREA' };

      let nearest: CityRecord | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const city of this.cities) {
        const d = distanceKm(lat, lng, city.lat, city.lng);
        if (d < best) {
          best = d;
          nearest = city;
        }
      }
      if (nearest && best <= this.options.maxNearestKm) {
        return { cityId: nearest.id, cityName: nearest.name, method: 'NEAREST' };
      }
    }

    const fallback = fallbackCityId === null ? undefined : this.byId.get(fallbackCityId);
    return fallback ? { cityId: fallback.id, cityName: fallback.name, method: 'FALLBACK' } : null;
  }
}

/** Loads every active city of one country with coordinates. */
export async function loadCityResolver(
  db: Pool,
  countryCode: string,
  options: CityResolverOptions,
): Promise<CityResolver> {
  const { rows } = await db.query<{
    id: number;
    name: string;
    lat: number;
    lng: number;
    population: number | null;
    bbox_south: number | null;
    bbox_west: number | null;
    bbox_north: number | null;
    bbox_east: number | null;
  }>(
    `SELECT id, name, lat, lng, population, bbox_south, bbox_west, bbox_north, bbox_east
     FROM locations
     WHERE type = 'CITY' AND active AND country_code = $1 AND lat IS NOT NULL AND lng IS NOT NULL`,
    [countryCode.toUpperCase()],
  );
  const cities: CityRecord[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    population: r.population,
    bbox:
      r.bbox_south !== null && r.bbox_west !== null && r.bbox_north !== null && r.bbox_east !== null
        ? { south: r.bbox_south, west: r.bbox_west, north: r.bbox_north, east: r.bbox_east }
        : null,
  }));
  return new CityResolver(cities, options);
}