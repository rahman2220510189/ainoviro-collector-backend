import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Launch scope of the claimable ainoviro pages (step 7.6, Marketplace Plan): which business
 * types (by Overture category) and which areas. Kept in seed/page-types.json so the scope can
 * change without code changes.
 */
const configSchema = z.object({
  types: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_]+$/),
        label: z.string().min(1),
        overture: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  areas: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_]+$/),
        label: z.string().min(1),
        match: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

export type PageTypesConfig = z.infer<typeof configSchema>;
export type PageType = PageTypesConfig['types'][number];
export type PageArea = PageTypesConfig['areas'][number];

export function parsePageTypes(raw: unknown): PageTypesConfig {
  const config = configSchema.parse(raw);
  const seen = new Set<string>();
  for (const t of config.types)
    for (const code of t.overture) {
      if (seen.has(code)) throw new Error(`Overture category "${code}" is in two page types`);
      seen.add(code);
    }
  return config;
}

let cached: PageTypesConfig | null = null;

export function loadPageTypes(): PageTypesConfig {
  if (!cached) {
    const file = join(__dirname, '..', '..', 'seed', 'page-types.json');
    cached = parsePageTypes(JSON.parse(readFileSync(file, 'utf8')));
  }
  return cached;
}

/** The page type of an Overture category, or null when it is not in the launch scope. */
export function typeOfOvertureCategory(
  config: PageTypesConfig,
  category: string | null | undefined,
): PageType | null {
  if (!category) return null;
  return config.types.find((t) => t.overture.includes(category)) ?? null;
}

/** The area a district or city name belongs to, or null. */
export function areaOfName(config: PageTypesConfig, ...names: (string | null | undefined)[]) {
  for (const name of names) {
    const value = name?.toLowerCase().trim();
    if (!value) continue;
    const area = config.areas.find((a) => a.match.some((m) => value.includes(m)));
    if (area) return area;
  }
  return null;
}
