import { describe, expect, it } from 'vitest';
import { cityBbox } from '../src/geonames/build';
import {
  containsPoint,
  estimateMinimumRequests,
  planSearchAreas,
  type PlanningCity,
} from '../src/planning/search-areas';
import { searchSettingsSchema } from '../src/services/settings';

const RADIUS = { minKm: 1.5, maxKm: 15, kmPerSqrtPopulation: 0.02 };

function city(
  id: number,
  name: string,
  lat: number,
  lng: number,
  population: number | null,
  parentId = 1,
  parentName = 'Nicosia',
): PlanningCity {
  return { id, name, parentId, parentName, lat, lng, population, bbox: cityBbox(lat, lng, population ?? 0, RADIUS) };
}

// Nicosia centre and a suburb ~3 km away; a far town; villages.
const NICOSIA = city(1, 'Nicosia', 35.1753, 33.3642, 200452);
const STROVOLOS = city(2, 'Strovolos', 35.1485, 33.3445, 67904);
const FAR_TOWN = city(3, 'Far Town', 35.02, 33.9, 8000, 2, 'Larnaca');
const VILLAGE_NEAR = city(4, 'Near Village', 35.19, 33.38, 900);
const VILLAGE_FAR_A = city(5, 'Far Village A', 34.8, 32.5, 300, 3, 'Paphos');
const VILLAGE_FAR_B = city(6, 'Far Village B', 34.9, 32.6, 0, 3, 'Paphos');
const ALL = [VILLAGE_FAR_A, STROVOLOS, VILLAGE_NEAR, NICOSIA, FAR_TOWN, VILLAGE_FAR_B];

describe('planSearchAreas', () => {
  const plan = planSearchAreas(ALL, { minCityPopulation: 5000, includeRural: true });

  it('makes each big city an area, biggest first', () => {
    expect(plan.areas.filter((a) => a.kind === 'CITY').map((a) => a.name)).toEqual(['Nicosia', 'Far Town']);
  });

  it('absorbs a big town lying inside a bigger city (Strovolos -> Nicosia)', () => {
    expect(plan.absorbed).toEqual([{ id: 2, name: 'Strovolos', intoName: 'Nicosia' }]);
    expect(plan.areas.find((a) => a.name === 'Nicosia')?.coveredCityIds).toContain(2);
  });

  it('covers a small place inside a searched city without a separate area', () => {
    expect(plan.coveredSmallPlaces).toBe(1);
    expect(plan.areas.find((a) => a.name === 'Nicosia')?.coveredCityIds).toContain(4);
  });

  it('groups the remaining small places into one rural area per district', () => {
    const rural = plan.areas.filter((a) => a.kind === 'RURAL');
    expect(rural.map((a) => a.name)).toEqual(['Paphos (rural)']);
    expect(rural[0]?.coveredCityIds.sort()).toEqual([5, 6]);
    expect(plan.ruralPlaces).toBe(2);
    // The rural box contains both villages.
    for (const v of [VILLAGE_FAR_A, VILLAGE_FAR_B]) {
      expect(rural[0] && containsPoint(rural[0].bbox, v.lat, v.lng)).toBe(true);
    }
  });

  it('leaves small places out when rural search is off', () => {
    const noRural = planSearchAreas(ALL, { minCityPopulation: 5000, includeRural: false });
    expect(noRural.areas.every((a) => a.kind === 'CITY')).toBe(true);
    expect(noRural.excludedRuralPlaces).toBe(2);
  });
});

describe('estimates and settings', () => {
  it('estimates at least one request per area and keyword', () => {
    expect(estimateMinimumRequests(8, 127)).toBe(1016);
  });

  it('fills missing search settings with defaults and rejects bad values', () => {
    expect(searchSettingsSchema.parse({})).toEqual({ minCityPopulation: 5000, includeRural: true, cooldownDays: 30 });
    expect(() => searchSettingsSchema.parse({ minCityPopulation: -1 })).toThrow();
  });
});