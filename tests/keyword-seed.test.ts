import { describe, expect, it } from 'vitest';
import { loadCategorySeed } from '../src/services/category-seed';
import { checkKeywordCoverage, keywordSeedFileSchema, loadKeywordSeed } from '../src/services/keyword-seed';

describe('seed/keywords.json', () => {
  const keywords = loadKeywordSeed();

  it('lists exactly the 65 subcategories of seed/categories.json', () => {
    expect(checkKeywordCoverage(keywords, loadCategorySeed())).toEqual([]);
    expect(Object.keys(keywords.subcategories)).toHaveLength(65);
  });

  it('uses only English and Greek, and every empty subcategory explains why', () => {
    for (const [key, entry] of Object.entries(keywords.subcategories)) {
      expect(Object.keys(entry.keywords).sort(), key).toEqual(['el', 'en']);
      const count = Object.values(entry.keywords).flat().length;
      if (count === 0) expect(entry.note, `${key} has no keywords and no note`).toBeTruthy();
    }
  });

  it('has no fashion keywords in Retail & Electronics (spec §4)', () => {
    const fashionWords = ['cloth', 'fashion', 'boutique', 'shoe', 'apparel', 'dress', 'ρούχα'];
    const retail = Object.entries(keywords.subcategories)
      .filter(([key]) => key.startsWith('retail-electronics/'))
      .flatMap(([, entry]) => Object.values(entry.keywords).flat());
    for (const keyword of retail) {
      expect(fashionWords.some((word) => keyword.includes(word)), keyword).toBe(false);
    }
  });
});

describe('keyword seed validation', () => {
  it('rejects the same keyword in two subcategories', () => {
    const file = {
      version: 1,
      subcategories: {
        'a/x': { keywords: { en: ['gym'], el: [] } },
        'b/y': { keywords: { en: ['gym'], el: [] } },
      },
    };
    expect(() => keywordSeedFileSchema.parse(file)).toThrow(/used in both/);
  });

  it('rejects uppercase keywords', () => {
    const file = { version: 1, subcategories: { 'a/x': { keywords: { en: ['Gym'], el: [] } } } };
    expect(() => keywordSeedFileSchema.parse(file)).toThrow();
  });
});