import type { PrismaClient } from '../generated/prisma/client';

/** One node of the lazy-loaded location tree. */
export interface LocationNode {
  id: number;
  parentId: number | null;
  type: 'COUNTRY' | 'REGION' | 'CITY';
  name: string;
  nameLocal: string | null;
  countryCode: string;
  population: number | null;
  /** Active children; 0 for cities. Lets the UI show an expand arrow. */
  childCount: number;
}

/** Read access used by the API (an interface so tests can use a fake). */
export interface LocationStore {
  /** Active children of a node, or the countries when parentId is null. */
  listChildren(parentId: number | null): Promise<LocationNode[]>;
  /** All active cities under the given nodes (a selected city counts itself). */
  resolveCityIds(ids: number[]): Promise<number[]>;
}

export function createPrismaLocationStore(prisma: PrismaClient): LocationStore {
  return {
    async listChildren(parentId) {
      const rows = await prisma.location.findMany({
        where: { parentId, active: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          parentId: true,
          type: true,
          name: true,
          nameLocal: true,
          countryCode: true,
          population: true,
          _count: { select: { children: { where: { active: true } } } },
        },
      });
      return rows.map(({ _count, ...node }) => ({ ...node, childCount: _count.children }));
    },

    async resolveCityIds(ids) {
      if (ids.length === 0) return [];
      // Walk down the tree from the selected nodes and keep the active cities.
      const rows = await prisma.$queryRaw<{ id: number }[]>`
        WITH RECURSIVE tree AS (
          SELECT id, type FROM locations WHERE id = ANY(${ids}::int[]) AND active
          UNION
          SELECT l.id, l.type FROM locations l JOIN tree t ON l.parent_id = t.id WHERE l.active
        )
        SELECT id FROM tree WHERE type = 'CITY' ORDER BY id`;
      return rows.map((r) => Number(r.id));
    },
  };
}