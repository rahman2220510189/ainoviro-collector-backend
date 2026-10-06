import type { PrismaClient } from '../generated/prisma/client';

type Box = { south: number; west: number; north: number; east: number };

/** Is there imported Overture data for this country? */
export async function hasOvertureData(prisma: PrismaClient, countryCode: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM stg_overture_places WHERE country_code = ${countryCode}) AS ok`;
  return rows[0]?.ok === true;
}

/**
 * Distinct Overture businesses inside any of the boxes, for the given subcategories
 * (plus places without a category when the job covers all categories). Areas can overlap
 * (a district's rural box contains its towns), so places are counted once.
 */
export async function countOvertureInBoxes(
  prisma: PrismaClient,
  p: { boxes: Box[]; subcategoryIds: number[]; allCategories: boolean },
): Promise<{ businesses: number; withEmail: number }> {
  if (p.boxes.length === 0) return { businesses: 0, withEmail: 0 };
  const boxes = JSON.stringify(
    p.boxes.map((b) => ({ south: b.south, west: b.west, north: b.north, east: b.east })),
  );
  const rows = await prisma.$queryRaw<{ businesses: number; with_email: number }[]>`
    WITH b AS (
      SELECT * FROM jsonb_to_recordset(${boxes}::jsonb)
        AS x(south float8, west float8, north float8, east float8)
    )
    SELECT count(*)::int AS businesses,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM emails e WHERE e.place_id = p.id AND e.mx_valid IS NOT FALSE
           ))::int AS with_email
    FROM places p
    WHERE EXISTS (SELECT 1 FROM b WHERE p.lat BETWEEN b.south AND b.north
                                    AND p.lng BETWEEN b.west AND b.east)
      AND EXISTS (SELECT 1 FROM place_sources s WHERE s.place_id = p.id AND s.source = 'OVERTURE')
      AND (
        EXISTS (SELECT 1 FROM place_subcategories ps
                WHERE ps.place_id = p.id AND ps.subcategory_id = ANY(${p.subcategoryIds}::int[]))
        OR (${p.allCategories}::boolean
            AND NOT EXISTS (SELECT 1 FROM place_subcategories ps WHERE ps.place_id = p.id))
      )`;
  return { businesses: rows[0]?.businesses ?? 0, withEmail: rows[0]?.with_email ?? 0 };
}
