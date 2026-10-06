import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyOverture,
  readOvertureMapFile,
  type CategoryRule,
} from '../src/datasets/category-map';

const rules: CategoryRule[] = [
  { match: 'food_and_drink', subcategoryId: 1, excludedReason: null },
  { match: 'food_and_drink > casual_eatery > bakery', subcategoryId: 2, excludedReason: null },
  { match: 'education', subcategoryId: 3, excludedReason: null },
  {
    match: 'education > place_of_learning > school',
    subcategoryId: null,
    excludedReason: 'school',
  },
  {
    match: 'education > place_of_learning > school > private_school',
    subcategoryId: 4,
    excludedReason: null,
  },
  { match: 'basic:fueling_station', subcategoryId: 5, excludedReason: null },
];
const place = (hierarchy: string[], basic: string | null = null) => ({
  taxonomyHierarchy: hierarchy,
  basicCategory: basic,
});

describe('Overture category rules', () => {
  it('the longest matching start of the path wins', () => {
    expect(classifyOverture(place(['food_and_drink', 'restaurant']), rules)).toMatchObject({
      kind: 'mapped',
      subcategoryId: 1,
    });
    expect(
      classifyOverture(place(['food_and_drink', 'casual_eatery', 'bakery', 'patisserie']), rules),
    ).toMatchObject({ kind: 'mapped', subcategoryId: 2 });
  });

  it('a more specific rule can exclude, and an even more specific one bring back', () => {
    expect(
      classifyOverture(place(['education', 'place_of_learning', 'school', 'high_school']), rules),
    ).toEqual({
      kind: 'excluded',
      reason: 'school',
      rule: 'education > place_of_learning > school',
    });
    expect(
      classifyOverture(
        place(['education', 'place_of_learning', 'school', 'private_school']),
        rules,
      ),
    ).toMatchObject({ kind: 'mapped', subcategoryId: 4 });
  });

  it('matches whole path steps only ("school" never matches "schoolbus")', () => {
    expect(
      classifyOverture(place(['education', 'place_of_learning', 'schoolbus']), rules),
    ).toMatchObject({ kind: 'mapped', subcategoryId: 3 });
  });

  it('basic: rules only for places without a path; otherwise unmapped', () => {
    expect(classifyOverture(place([], 'fueling_station'), rules)).toMatchObject({
      kind: 'mapped',
      subcategoryId: 5,
    });
    expect(classifyOverture(place([], 'something_else'), rules)).toEqual({ kind: 'unmapped' });
    expect(classifyOverture(place(['shopping', 'shoe_store']), rules)).toEqual({
      kind: 'unmapped',
    });
  });

  it('the shipped map file is valid and has no duplicate rules', () => {
    const file = readOvertureMapFile();
    expect(file.length).toBeGreaterThan(50);
    expect(file.some((r) => r.match === 'community_and_government' && 'exclude' in r)).toBe(true);
  });

  it('a duplicate rule in the file is refused', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'map-'));
    try {
      const f = path.join(dir, 'map.json');
      writeFileSync(
        f,
        JSON.stringify({
          version: 1,
          rules: [
            { match: 'a', to: 'x/y' },
            { match: 'a', exclude: 'no' },
          ],
        }),
      );
      expect(() => readOvertureMapFile(f)).toThrow('appears twice');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
