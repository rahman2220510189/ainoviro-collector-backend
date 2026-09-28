import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';
import type { CategorySeedFile } from './category-seed';

const keywordSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .refine((value) => value === value.toLowerCase(), 'keywords must be lowercase');

const entrySchema = z
  .object({
    /** Language code -> Google Maps search phrases, e.g. { en: [...], el: [...] }. */
    keywords: z.record(z.string().regex(/^[a-z]{2,3}$/, 'language must be a code like "en"'), z.array(keywordSchema)),
    /** Why a subcategory has no or few keywords (for reviewers). */
    note: z.string().optional(),
  })
  .strict();

/**
 * Schema of seed/keywords.json. Keys are "categorySlug/subcategorySlug".
 * A keyword may appear only ONCE per language in the whole file: the same
 * search in two subcategories would spend requests twice.
 */
export const keywordSeedFileSchema = z
  .object({
    version: z.literal(1),
    subcategories: z.record(z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/), entrySchema),
  })
  .superRefine((file, ctx) => {
    const owner = new Map<string, string>(); // "lang|keyword" -> subcategory key
    for (const [key, entry] of Object.entries(file.subcategories)) {
      for (const [language, keywords] of Object.entries(entry.keywords)) {
        for (const keyword of keywords) {
          const id = `${language}|${keyword}`;
          const first = owner.get(id);
          if (first !== undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['subcategories', key, 'keywords', language],
              message: `keyword "${keyword}" (${language}) is used in both "${first}" and "${key}"`,
            });
          } else {
            owner.set(id, key);
          }
        }
      }
    }
  });

export type KeywordSeedFile = z.infer<typeof keywordSeedFileSchema>;

/** Works from both src/services (tsx) and dist/services (compiled). */
export const KEYWORD_SEED_PATH = path.join(__dirname, '../../seed/keywords.json');

export function loadKeywordSeed(filePath: string = KEYWORD_SEED_PATH): KeywordSeedFile {
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return keywordSeedFileSchema.parse(JSON.parse(text) as unknown);
}

/**
 * Compares the keyword file with the category file. Every subcategory must be
 * listed exactly (an empty list is fine, but it must be a conscious choice).
 */
export function checkKeywordCoverage(keywords: KeywordSeedFile, categories: CategorySeedFile): string[] {
  const expected = new Set(
    categories.categories.flatMap((c) => c.subcategories.map((s) => `${c.slug}/${s.slug}`)),
  );
  const listed = new Set(Object.keys(keywords.subcategories));
  const problems: string[] = [];
  for (const key of expected) if (!listed.has(key)) problems.push(`missing subcategory "${key}"`);
  for (const key of listed) if (!expected.has(key)) problems.push(`unknown subcategory "${key}"`);
  return problems;
}

export interface KeywordSyncResult {
  created: number;
  reactivated: number;
  deactivated: number;
  unchanged: number;
}

/**
 * Makes subcategory_keywords match the file in one transaction:
 * new keywords are created, removed ones deactivated (never deleted), and
 * previously deactivated ones that are back in the file reactivated.
 */
export async function syncKeywords(prisma: PrismaClient, file: KeywordSeedFile): Promise<KeywordSyncResult> {
  return prisma.$transaction(
    async (tx) => {
      const subcategories = await tx.subcategory.findMany({
        select: { id: true, slug: true, category: { select: { slug: true } } },
      });
      const idByKey = new Map(subcategories.map((s) => [`${s.category.slug}/${s.slug}`, s.id]));

      const wanted: { subcategoryId: number; language: string; keyword: string }[] = [];
      for (const [key, entry] of Object.entries(file.subcategories)) {
        const subcategoryId = idByKey.get(key);
        if (subcategoryId === undefined) {
          throw new Error(`Subcategory "${key}" is not in the database. Run npm run seed:categories first.`);
        }
        for (const [language, keywords] of Object.entries(entry.keywords)) {
          for (const keyword of keywords) wanted.push({ subcategoryId, language, keyword });
        }
      }

      const keyOf = (r: { subcategoryId: number; language: string; keyword: string }) =>
        `${r.subcategoryId}|${r.language}|${r.keyword}`;
      const wantedKeys = new Set(wanted.map(keyOf));
      const existing = await tx.subcategoryKeyword.findMany({
        select: { id: true, subcategoryId: true, language: true, keyword: true, active: true },
      });
      const existingKeys = new Set(existing.map(keyOf));

      const toCreate = wanted.filter((w) => !existingKeys.has(keyOf(w)));
      const toReactivate = existing.filter((r) => wantedKeys.has(keyOf(r)) && !r.active).map((r) => r.id);
      const toDeactivate = existing.filter((r) => !wantedKeys.has(keyOf(r)) && r.active).map((r) => r.id);

      if (toCreate.length > 0) await tx.subcategoryKeyword.createMany({ data: toCreate });
      if (toReactivate.length > 0) {
        await tx.subcategoryKeyword.updateMany({ where: { id: { in: toReactivate } }, data: { active: true } });
      }
      if (toDeactivate.length > 0) {
        await tx.subcategoryKeyword.updateMany({ where: { id: { in: toDeactivate } }, data: { active: false } });
      }

      return {
        created: toCreate.length,
        reactivated: toReactivate.length,
        deactivated: toDeactivate.length,
        unchanged: wanted.length - toCreate.length - toReactivate.length,
      };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}