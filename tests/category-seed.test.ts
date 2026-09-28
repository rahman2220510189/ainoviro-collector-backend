import { describe, expect, it } from 'vitest';
import { categorySeedFileSchema, loadCategorySeed } from '../src/services/category-seed';

/** The 16 names confirmed by the owner to match the live ainoviro site (2026-09-24). */
const CONFIRMED_CATEGORY_NAMES = [
  'Personal Care & Beauty',
  'Health & Wellness',
  'Fitness & Sports',
  'Home & Lifestyle & Pets',
  'Professional & Business Services',
  'Education & Coaching',
  'Events & Experiences',
  'Retail & Electronics',
  'Legal, Financial & Insurance',
  'Automotive & Mobility',
  'Travel & Hospitality',
  'Food & Beverage',
  'Real Estate & Property',
  'Specialised Industries',
  'Food & Natural Products',
  'Fashion & Accessories',
];

describe('seed/categories.json', () => {
  const seed = loadCategorySeed();

  it('contains exactly the 16 confirmed category names, in order', () => {
    expect(seed.categories.map((c) => c.displayName)).toEqual(CONFIRMED_CATEGORY_NAMES);
  });

  it('contains 65 subcategories: 5 for Fashion & Accessories, 4 for every other category', () => {
    const total = seed.categories.reduce((sum, c) => sum + c.subcategories.length, 0);
    expect(total).toBe(65);
    for (const category of seed.categories) {
      const expected = category.slug === 'fashion-accessories' ? 5 : 4;
      expect(category.subcategories, category.displayName).toHaveLength(expected);
    }
  });
});

describe('category seed validation', () => {
  it('rejects duplicate category slugs', () => {
    const file = {
      version: 1,
      categories: [
        { slug: 'same', displayName: 'A', subcategories: [{ slug: 'x', displayName: 'X' }] },
        { slug: 'same', displayName: 'B', subcategories: [{ slug: 'y', displayName: 'Y' }] },
      ],
    };
    expect(() => categorySeedFileSchema.parse(file)).toThrow(/duplicate category slug/);
  });

  it('rejects an invalid slug format', () => {
    const file = {
      version: 1,
      categories: [
        { slug: 'Bad Slug!', displayName: 'A', subcategories: [{ slug: 'x', displayName: 'X' }] },
      ],
    };
    expect(() => categorySeedFileSchema.parse(file)).toThrow();
  });
});