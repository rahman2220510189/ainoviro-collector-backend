import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCountryBorder, readCountryBorder } from '../src/datasets/country-border';
import { readOverturePlaces } from '../src/datasets/overture';

const FIXTURES = path.join(__dirname, 'fixtures');
const DIVISIONS = path.join(FIXTURES, 'divisions-cy.parquet');
const CY = path.join(FIXTURES, 'overture-cy.parquet');
const BOX = { south: 34.5, west: 32.2, north: 35.7, east: 34.6 };

const square = (w: number, s: number, e: number, n: number) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

describe('country outline (point in polygon)', () => {
  it('tells inside from outside, and a lake (hole) is outside', () => {
    const border = buildCountryBorder('GR', [
      { type: 'Polygon', coordinates: [square(20, 35, 26, 41), square(22, 38, 23, 39)] },
    ]);
    expect(border.contains(21, 36)).toBe(true);
    expect(border.contains(22.5, 38.5)).toBe(false); // in the hole
    expect(border.contains(27, 38)).toBe(false); // east of it ("Turkey")
    expect(border.contains(21, 41.5)).toBe(false);
  });

  it('handles islands (MultiPolygon) and a concave coastline', () => {
    // An "L" shape: the inner corner (24..26, 38..41) is sea.
    const mainland = [
      [20, 35],
      [26, 35],
      [26, 38],
      [24, 38],
      [24, 41],
      [20, 41],
      [20, 35],
    ];
    const border = buildCountryBorder('GR', [
      { type: 'MultiPolygon', coordinates: [[mainland], [square(28, 36, 28.5, 36.5)]] },
    ]);
    expect(border.areas).toBe(1);
    expect(border.contains(21, 40)).toBe(true);
    expect(border.contains(25, 39)).toBe(false); // the inner corner
    expect(border.contains(28.2, 36.2)).toBe(true); // the island
  });

  it('a point exactly on a band edge or at the box corner does not crash', () => {
    const border = buildCountryBorder('MT', [
      { type: 'Polygon', coordinates: [square(14.18, 35.8, 14.58, 36.08)] },
    ]);
    expect(border.contains(14.3, 35.8)).toBe(true);
    expect(border.contains(14.3, 36.08)).toBe(false);
    expect(border.contains(14.6, 35.9)).toBe(false);
  });

  it('reads the outline from Overture division_area data (country rows only)', async () => {
    const border = await readCountryBorder([DIVISIONS], BOX, 'CY');
    expect(border).not.toBeNull();
    // Only the CY "country" row: the CY region and the TR country are not used.
    expect(border?.areas).toBe(1);
    expect(border?.contains(33.0, 34.7)).toBe(true);
    expect(border?.contains(33.06, 34.71)).toBe(false);

    const zz = await readCountryBorder([DIVISIONS], BOX, 'ZZ');
    expect(zz?.contains(33.22, 34.86)).toBe(true); // the island of the MultiPolygon
    expect(await readCountryBorder([DIVISIONS], BOX, 'MT')).toBeNull();
  });

  it('drops places with no address country outside the outline; an address country decides', async () => {
    const border = await readCountryBorder([DIVISIONS], BOX, 'CY');
    const { kept, stats } = await readOverturePlaces(
      [CY],
      BOX,
      'CY',
      0.6,
      undefined,
      false,
      border,
    );
    // ov-noaddr (no address, outside) is dropped; ov-gym is outside too but its address says CY.
    expect(kept.map((p) => p.id).sort()).toEqual(['ov-gym', 'ov-salon']);
    expect(stats).toMatchObject({ droppedOutsideBorder: 1, borderUsed: true, kept: 2 });

    const boxOnly = await readOverturePlaces([CY], BOX, 'CY', 0.6);
    expect(boxOnly.stats).toMatchObject({ droppedOutsideBorder: 0, borderUsed: false, kept: 3 });
  });
});
