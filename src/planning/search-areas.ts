import { unionBbox, type Bbox } from '../geonames/build';

/** A city/village as the planner needs it. */
export interface PlanningCity {
  id: number;
  name: string;
  parentId: number | null;
  parentName: string | null;
  lat: number;
  lng: number;
  population: number | null;
  bbox: Bbox;
}

/** One area that will be searched with every selected keyword. */
export interface SearchArea {
  /** Stable key, e.g. "city:12" or "rural:5". */
  key: string;
  kind: 'CITY' | 'RURAL';
  /** The city itself, or the district for rural areas. */
  locationId: number;
  name: string;
  population: number | null;
  bbox: Bbox;
  /** Every selected place this area covers (for reporting). */
  coveredCityIds: number[];
}

export interface AbsorbedCity {
  id: number;
  name: string;
  intoName: string;
}

export interface SearchPlan {
  areas: SearchArea[];
  /** Large cities that lie inside a bigger city's box (e.g. Strovolos -> Nicosia). */
  absorbed: AbsorbedCity[];
  /** Small places already inside a searched city. */
  coveredSmallPlaces: number;
  /** Small places covered by district-level rural areas. */
  ruralPlaces: number;
  /** Small places not covered because rural search is off. */
  excludedRuralPlaces: number;
}

export interface PlanOptions {
  /** Places with at least this population are searched on their own. */
  minCityPopulation: number;
  /** Cover the remaining small places with one rural area per district. */
  includeRural: boolean;
}

export function containsPoint(box: Bbox, lat: number, lng: number): boolean {
  return lat >= box.south && lat <= box.north && lng >= box.west && lng <= box.east;
}

/**
 * Decides WHERE to search so the same ground is not paid for twice:
 * 1. cities >= minCityPopulation become areas, biggest first;
 * 2. a big city whose centre lies inside an already chosen city is absorbed;
 * 3. small places inside a chosen city are covered by it;
 * 4. the remaining small places form one rural area per district (optional).
 * Initial grid tiling is not done here: dense searches are split adaptively later.
 */
export function planSearchAreas(cities: PlanningCity[], options: PlanOptions): SearchPlan {
  const plan: SearchPlan = {
    areas: [],
    absorbed: [],
    coveredSmallPlaces: 0,
    ruralPlaces: 0,
    excludedRuralPlaces: 0,
  };

  // Biggest first, so every big city is placed before any small place is checked.
  const byPopulation = [...cities].sort(
    (a, b) => (b.population ?? 0) - (a.population ?? 0) || a.id - b.id,
  );

  const cityAreas: SearchArea[] = [];
  const smallLeftOver: PlanningCity[] = [];

  for (const city of byPopulation) {
    const container = cityAreas.find((area) => containsPoint(area.bbox, city.lat, city.lng));
    const isBig = (city.population ?? 0) >= options.minCityPopulation;

    if (isBig && container) {
      container.coveredCityIds.push(city.id);
      plan.absorbed.push({ id: city.id, name: city.name, intoName: container.name });
    } else if (isBig) {
      cityAreas.push({
        key: `city:${city.id}`,
        kind: 'CITY',
        locationId: city.id,
        name: city.name,
        population: city.population,
        bbox: city.bbox,
        coveredCityIds: [city.id],
      });
    } else if (container) {
      container.coveredCityIds.push(city.id);
      plan.coveredSmallPlaces += 1;
    } else {
      smallLeftOver.push(city);
    }
  }

  const ruralAreas: SearchArea[] = [];
  if (options.includeRural) {
    const byDistrict = new Map<number | null, PlanningCity[]>();
    for (const place of smallLeftOver) {
      const group = byDistrict.get(place.parentId) ?? [];
      group.push(place);
      byDistrict.set(place.parentId, group);
    }
    for (const [districtId, places] of byDistrict) {
      const first = places[0];
      let box: Bbox | null = null;
      for (const place of places) box = unionBbox(box, place.bbox);
      if (!first || !box) continue;
      ruralAreas.push({
        key: `rural:${districtId ?? `place-${first.id}`}`,
        kind: 'RURAL',
        locationId: districtId ?? first.id,
        name: `${first.parentName ?? 'Unassigned'} (rural)`,
        population: null,
        bbox: box,
        coveredCityIds: places.map((p) => p.id),
      });
      plan.ruralPlaces += places.length;
    }
    ruralAreas.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    plan.excludedRuralPlaces = smallLeftOver.length;
  }

  plan.areas = [...cityAreas, ...ruralAreas];
  return plan;
}

/**
 * Lower bound: one request per (area, keyword). Extra result pages and
 * adaptive splitting of dense areas add more (full estimate in step 1.6).
 */
export function estimateMinimumRequests(areaCount: number, keywordCount: number): number {
  return areaCount * keywordCount;
}