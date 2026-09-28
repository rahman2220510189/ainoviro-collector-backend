import type { PrismaClient } from '../generated/prisma/client';
import type { PlanningCity } from '../planning/search-areas';

export interface LoadedCities {
  cities: PlanningCity[];
  /** Places without coordinates or box (cannot be searched). */
  missingGeometry: number;
}

/** Loads the given city ids with everything the planner needs. */
export async function loadPlanningCities(prisma: PrismaClient, cityIds: number[]): Promise<LoadedCities> {
  const rows = await prisma.location.findMany({
    where: { id: { in: cityIds }, type: 'CITY' },
    select: {
      id: true,
      name: true,
      parentId: true,
      lat: true,
      lng: true,
      population: true,
      bboxSouth: true,
      bboxWest: true,
      bboxNorth: true,
      bboxEast: true,
      parent: { select: { name: true } },
    },
  });

  const cities: PlanningCity[] = [];
  let missingGeometry = 0;
  for (const row of rows) {
    const { lat, lng, bboxSouth, bboxWest, bboxNorth, bboxEast } = row;
    if (lat === null || lng === null || bboxSouth === null || bboxWest === null || bboxNorth === null || bboxEast === null) {
      missingGeometry += 1;
      continue;
    }
    cities.push({
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      parentName: row.parent?.name ?? null,
      lat,
      lng,
      population: row.population,
      bbox: { south: bboxSouth, west: bboxWest, north: bboxNorth, east: bboxEast },
    });
  }
  return { cities, missingGeometry };
}

/** Active category slugs, in display order. */
export async function listActiveCategorySlugs(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.category.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    select: { slug: true },
  });
  return rows.map((r) => r.slug);
}

/** Number of active keywords for the chosen languages and categories (null = all). */
export function countKeywords(
  prisma: PrismaClient,
  languages: string[],
  categorySlugs: string[] | null,
): Promise<number> {
  return prisma.subcategoryKeyword.count({
    where: {
      active: true,
      language: { in: languages },
      subcategory: {
        active: true,
        category: { active: true, ...(categorySlugs ? { slug: { in: categorySlugs } } : {}) },
      },
    },
  });
}