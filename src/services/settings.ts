import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';

/** Search planning settings, stored as JSON in settings.key = "search". */
export const searchSettingsSchema = z.object({
  minCityPopulation: z.number().int().min(0).default(5000),
  includeRural: z.boolean().default(true),
    /** Do not repeat the same search (area + keyword + language) within this many days. 0 = off. */
  cooldownDays: z.number().int().min(0).max(365).default(30),
});

export type SearchSettings = z.infer<typeof searchSettingsSchema>;

export const SEARCH_SETTINGS_KEY = 'search';

/** Reads the search settings; missing values fall back to the defaults above. */
export async function loadSearchSettings(prisma: PrismaClient): Promise<SearchSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SEARCH_SETTINGS_KEY } });
  return searchSettingsSchema.parse(row?.value ?? {});
}