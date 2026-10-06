import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

/**
 * Overture category -> our subcategory (spec §6.2 "source_category_map"). A rule matches
 * the START of a place's taxonomy path ("food_and_drink > restaurant" also matches
 * "food_and_drink > restaurant > pizza_restaurant"); the longest matching rule wins.
 * "basic:<name>" rules are used only for places without a taxonomy path.
 */

export const OVERTURE_MAP_FILE = path.join(__dirname, '../../seed/overture-category-map.json');

const ruleSchema = z.union([
  z.object({ match: z.string().min(1), to: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/) }),
  z.object({ match: z.string().min(1), exclude: z.string().min(1) }),
]);
const mapFileSchema = z.object({
  version: z.literal(1),
  about: z.string().optional(),
  rules: z.array(ruleSchema).min(1),
});
export type MapFileRule = z.infer<typeof ruleSchema>;

export function readOvertureMapFile(file: string = OVERTURE_MAP_FILE): MapFileRule[] {
  const parsed = mapFileSchema.parse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  const seen = new Set<string>();
  for (const r of parsed.rules) {
    if (seen.has(r.match)) throw new Error(`Rule "${r.match}" appears twice in the map file.`);
    seen.add(r.match);
  }
  return parsed.rules;
}

/** One active rule as the matcher uses it. */
export interface CategoryRule {
  match: string;
  subcategoryId: number | null;
  excludedReason: string | null;
}

export type Classification =
  | { kind: 'mapped'; subcategoryId: number; rule: string }
  | { kind: 'excluded'; reason: string; rule: string }
  | { kind: 'unmapped' };

/**
 * Longest-prefix match on the taxonomy path; "basic:" rules only when there is no path
 * (matched against the basic category, then the primary category).
 */
export function classifyOverture(
  place: {
    taxonomyHierarchy: string[];
    basicCategory: string | null;
    taxonomyPrimary?: string | null;
  },
  rules: CategoryRule[],
): Classification {
  const pathText = place.taxonomyHierarchy.join(' > ');
  let best: CategoryRule | null = null;
  if (pathText !== '') {
    for (const r of rules) {
      if (r.match.startsWith('basic:')) continue;
      if (pathText === r.match || pathText.startsWith(`${r.match} > `)) {
        if (!best || r.match.length > best.match.length) best = r;
      }
    }
  } else {
    // No path: the basic category, else the primary category, can match a "basic:" rule.
    for (const name of [place.basicCategory, place.taxonomyPrimary]) {
      if (!best && name) best = rules.find((r) => r.match === `basic:${name}`) ?? null;
    }
  }
  if (!best) return { kind: 'unmapped' };
  if (best.excludedReason)
    return { kind: 'excluded', reason: best.excludedReason, rule: best.match };
  return { kind: 'mapped', subcategoryId: best.subcategoryId as number, rule: best.match };
}

export async function loadOvertureRules(db: Pool | PoolClient): Promise<CategoryRule[]> {
  const { rows } = await db.query<{
    source_category: string;
    subcategory_id: number | null;
    excluded_reason: string | null;
  }>(
    `SELECT source_category, subcategory_id, excluded_reason FROM source_category_map
     WHERE source = 'OVERTURE' AND active`,
  );
  return rows.map((r) => ({
    match: r.source_category,
    subcategoryId: r.subcategory_id,
    excludedReason: r.excluded_reason,
  }));
}

export interface SeedResult {
  created: number;
  updated: number;
  removed: number;
}

/**
 * Makes the Overture rules in the database match the file, in one transaction. Every
 * "category/subcategory" target must exist and be active, otherwise nothing changes.
 */
export async function seedOvertureMap(db: Pool, rules: MapFileRule[]): Promise<SeedResult> {
  const { rows: subs } = await db.query<{ id: number; key: string }>(
    `SELECT s.id, c.slug || '/' || s.slug AS key FROM subcategories s
     JOIN categories c ON c.id = s.category_id WHERE s.active AND c.active`,
  );
  const idOf = new Map(subs.map((s) => [s.key, s.id]));
  const missing = rules
    .filter((r) => 'to' in r && !idOf.has(r.to))
    .map((r) => ('to' in r ? r.to : ''));
  if (missing.length > 0) {
    throw new Error(
      `Unknown subcategories in the map file: ${[...new Set(missing)].join(', ')}. Run seed:categories first?`,
    );
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query<{ source_category: string }>(
      `SELECT source_category FROM source_category_map WHERE source = 'OVERTURE'`,
    );
    const existing = new Set(before.rows.map((r) => r.source_category));
    let created = 0;
    let updated = 0;
    for (const r of rules) {
      const subcategoryId = 'to' in r ? (idOf.get(r.to) as number) : null;
      const reason = 'exclude' in r ? r.exclude : null;
      await client.query(
        `INSERT INTO source_category_map (source, source_category, subcategory_id, excluded_reason, active)
         VALUES ('OVERTURE', $1, $2, $3, true)
         ON CONFLICT (source, source_category) DO UPDATE
           SET subcategory_id = EXCLUDED.subcategory_id, excluded_reason = EXCLUDED.excluded_reason,
               active = true`,
        [r.match, subcategoryId, reason],
      );
      if (existing.has(r.match)) updated += 1;
      else created += 1;
    }
    const removed = await client.query(
      `DELETE FROM source_category_map WHERE source = 'OVERTURE' AND NOT (source_category = ANY($1::text[]))`,
      [rules.map((r) => r.match)],
    );
    await client.query('COMMIT');
    return { created, updated, removed: removed.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface MappingReport {
  total: number;
  mapped: number;
  mappedWithEmail: number;
  excluded: number;
  unmapped: number;
  byCategory: { category: string; places: number; withEmail: number }[];
  byExclusion: { reason: string; places: number; withEmail: number }[];
  topUnmapped: { category: string; places: number }[];
}

/** How the current rules sort one country's imported Overture places (read only). */
export async function overtureMappingReport(db: Pool, countryCode: string): Promise<MappingReport> {
  const rules = await loadOvertureRules(db);
  const { rows: subs } = await db.query<{ id: number; name: string }>(
    `SELECT s.id, c.display_name AS name FROM subcategories s JOIN categories c ON c.id = s.category_id`,
  );
  const categoryOf = new Map(subs.map((s) => [s.id, s.name]));
  const { rows } = await db.query<{
    taxonomy_hierarchy: string[];
    basic_category: string | null;
    taxonomy_primary: string | null;
    has_email: boolean;
  }>(
    `SELECT taxonomy_hierarchy, basic_category, taxonomy_primary, cardinality(emails) > 0 AS has_email
     FROM stg_overture_places WHERE country_code = $1`,
    [countryCode],
  );
  const cats = new Map<string, { places: number; withEmail: number }>();
  const excl = new Map<string, { places: number; withEmail: number }>();
  const unm = new Map<string, number>();
  let mapped = 0;
  let mappedWithEmail = 0;
  let excluded = 0;
  let unmapped = 0;
  const bump = (m: Map<string, { places: number; withEmail: number }>, k: string, e: boolean) => {
    const v = m.get(k) ?? { places: 0, withEmail: 0 };
    v.places += 1;
    if (e) v.withEmail += 1;
    m.set(k, v);
  };
  for (const r of rows) {
    const c = classifyOverture(
      {
        taxonomyHierarchy: r.taxonomy_hierarchy,
        basicCategory: r.basic_category,
        taxonomyPrimary: r.taxonomy_primary,
      },
      rules,
    );
    if (c.kind === 'mapped') {
      mapped += 1;
      if (r.has_email) mappedWithEmail += 1;
      bump(cats, categoryOf.get(c.subcategoryId) ?? '?', r.has_email);
    } else if (c.kind === 'excluded') {
      excluded += 1;
      bump(excl, c.reason, r.has_email);
    } else {
      unmapped += 1;
      const k = r.taxonomy_primary ?? r.basic_category ?? '(no category in Overture)';
      unm.set(k, (unm.get(k) ?? 0) + 1);
    }
  }
  const sorted = (m: Map<string, { places: number; withEmail: number }>) =>
    [...m].sort((a, b) => b[1].places - a[1].places);
  return {
    total: rows.length,
    mapped,
    mappedWithEmail,
    excluded,
    unmapped,
    byCategory: sorted(cats).map(([category, v]) => ({ category, ...v })),
    byExclusion: sorted(excl).map(([reason, v]) => ({ reason, ...v })),
    topUnmapped: [...unm]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([category, places]) => ({ category, places })),
  };
}
