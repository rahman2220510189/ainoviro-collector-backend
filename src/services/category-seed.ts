import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugSchema = z.string().regex(SLUG_PATTERN, 'slug must be lowercase words separated by "-"');

const subcategorySeedSchema = z.object({
  slug: slugSchema,
  displayName: z.string().trim().min(1),
});

const categorySeedSchema = z.object({
  slug: slugSchema,
  /** Must match the live ainoviro site exactly (used in the CSV). */
  displayName: z.string().trim().min(1),
  subcategories: z.array(subcategorySeedSchema).min(1),
});

/** Schema of seed/categories.json. Array order = display order (sort_order). */
export const categorySeedFileSchema = z
  .object({
    version: z.literal(1),
    categories: z.array(categorySeedSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const categorySlugs = new Set<string>();
    file.categories.forEach((category, i) => {
      if (categorySlugs.has(category.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['categories', i, 'slug'],
          message: `duplicate category slug "${category.slug}"`,
        });
      }
      categorySlugs.add(category.slug);

      // Subcategory slugs only need to be unique within their category.
      const subSlugs = new Set<string>();
      category.subcategories.forEach((sub, j) => {
        if (subSlugs.has(sub.slug)) {
          ctx.addIssue({
            code: 'custom',
            path: ['categories', i, 'subcategories', j, 'slug'],
            message: `duplicate subcategory slug "${sub.slug}" in "${category.slug}"`,
          });
        }
        subSlugs.add(sub.slug);
      });
    });
  });

export type CategorySeedFile = z.infer<typeof categorySeedFileSchema>;

/** Works from both src/services (tsx) and dist/services (compiled). */
export const CATEGORY_SEED_PATH = path.join(__dirname, '../../seed/categories.json');

/** Reads and validates the category seed file. Throws ZodError if it is invalid. */
export function loadCategorySeed(filePath: string = CATEGORY_SEED_PATH): CategorySeedFile {
  // Strip a UTF-8 BOM if an editor added one.
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return categorySeedFileSchema.parse(JSON.parse(text) as unknown);
}