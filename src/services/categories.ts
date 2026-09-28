import type { PrismaClient } from '../generated/prisma/client';
import type { CategorySeedFile } from './category-seed';

export interface SubcategoryNode {
  id: number;
  slug: string;
  displayName: string;
  sortOrder: number;
  active: boolean;
}

export interface CategoryNode extends SubcategoryNode {
  subcategories: SubcategoryNode[];
}

/** Read access used by the API (an interface so tests can use a fake). */
export interface CategoryStore {
  listCategoryTree(includeInactive: boolean): Promise<CategoryNode[]>;
}

const NODE_SELECT = {
  id: true,
  slug: true,
  displayName: true,
  sortOrder: true,
  active: true,
} as const;

export function createPrismaCategoryStore(prisma: PrismaClient): CategoryStore {
  return {
    listCategoryTree(includeInactive) {
      const activeOnly = includeInactive ? undefined : { active: true };
      return prisma.category.findMany({
        where: activeOnly,
        orderBy: { sortOrder: 'asc' },
        select: {
          ...NODE_SELECT,
          subcategories: { where: activeOnly, orderBy: { sortOrder: 'asc' }, select: NODE_SELECT },
        },
      });
    },
  };
}

export interface SyncCounts {
  created: number;
  updated: number;
  deactivated: number;
}

export interface SyncResult {
  categories: SyncCounts;
  subcategories: SyncCounts;
}

/**
 * Makes the database match the seed file, in one transaction:
 * - new entries are created, existing ones updated (name, order, active)
 * - entries missing from the file are DEACTIVATED, never deleted,
 *   because places and jobs may still reference them.
 * Safe to run any number of times.
 */
export async function syncCategories(
  prisma: PrismaClient,
  seed: CategorySeedFile,
): Promise<SyncResult> {
  return prisma.$transaction(
    async (tx) => {
      const result: SyncResult = {
        categories: { created: 0, updated: 0, deactivated: 0 },
        subcategories: { created: 0, updated: 0, deactivated: 0 },
      };

      // Load what already exists once, to avoid a lookup per row.
      const existingCategories = new Map(
        (await tx.category.findMany({ select: { id: true, slug: true } })).map((c) => [
          c.slug,
          c.id,
        ]),
      );
      const existingSubcategories = new Set(
        (await tx.subcategory.findMany({ select: { categoryId: true, slug: true } })).map(
          (s) => `${s.categoryId}:${s.slug}`,
        ),
      );

      const keptCategoryIds: number[] = [];

      for (const [i, category] of seed.categories.entries()) {
        const saved = await tx.category.upsert({
          where: { slug: category.slug },
          create: { slug: category.slug, displayName: category.displayName, sortOrder: i },
          update: { displayName: category.displayName, sortOrder: i, active: true },
          select: { id: true },
        });
        if (existingCategories.has(category.slug)) result.categories.updated += 1;
        else result.categories.created += 1;
        keptCategoryIds.push(saved.id);

        const keptSubSlugs: string[] = [];
        for (const [j, sub] of category.subcategories.entries()) {
          await tx.subcategory.upsert({
            where: { categoryId_slug: { categoryId: saved.id, slug: sub.slug } },
            create: {
              categoryId: saved.id,
              slug: sub.slug,
              displayName: sub.displayName,
              sortOrder: j,
            },
            update: { displayName: sub.displayName, sortOrder: j, active: true },
          });
          if (existingSubcategories.has(`${saved.id}:${sub.slug}`)) {
            result.subcategories.updated += 1;
          } else {
            result.subcategories.created += 1;
          }
          keptSubSlugs.push(sub.slug);
        }

        const removedSubs = await tx.subcategory.updateMany({
          where: { categoryId: saved.id, slug: { notIn: keptSubSlugs }, active: true },
          data: { active: false },
        });
        result.subcategories.deactivated += removedSubs.count;
      }

      // Categories no longer in the file, and all their subcategories.
      const removedCategories = await tx.category.updateMany({
        where: { id: { notIn: keptCategoryIds }, active: true },
        data: { active: false },
      });
      result.categories.deactivated += removedCategories.count;

      const orphanedSubs = await tx.subcategory.updateMany({
        where: { categoryId: { notIn: keptCategoryIds }, active: true },
        data: { active: false },
      });
      result.subcategories.deactivated += orphanedSubs.count;

      return result;
    },
    // Many small queries to a remote database: allow plenty of time.
    { timeout: 120_000, maxWait: 10_000 },
  );
}