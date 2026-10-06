import type { Pool } from 'pg';
import { z } from 'zod';

/** Free dataset settings, stored as JSON in settings.key = "datasets". Spec §6.2. */
export const datasetSettingsSchema = z.object({
  overture: z
    .object({
      /** Places below this confidence (0..1, "does it exist?") are skipped. */
      minConfidence: z.number().min(0).max(1).default(0.6),
      /** Skip places with no email and no own website: they can never become a lead. */
      onlyWithContact: z.boolean().default(true),
      /** A fixed release such as "2026-09-23.0"; null = the newest one. */
      release: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}\.\d+$/, 'release looks like 2026-09-23.0')
        .nullable()
        .default(null),
    })
    .default({ minConfidence: 0.6, onlyWithContact: true, release: null }),
  foursquare: z
    .object({
      /** Places not refreshed by Foursquare for longer than this are skipped (spec: 24). */
      maxAgeMonths: z.number().int().min(1).max(120).default(24),
      /** A fixed release date such as "2026-08-11"; null = the newest one. */
      release: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'release looks like 2026-08-11')
        .nullable()
        .default(null),
    })
    .default({ maxAgeMonths: 24, release: null }),
  /**
   * The database may not grow past this (MB). Neon's free plan has 1 GB per project
   * (since 2 Oct 2026); some room is kept for the leads, crawls and exports that follow.
   * An import that would pass it stops before saving anything.
   */
  storageLimitMb: z.number().int().min(100).max(1_000_000).default(900),
});

export type DatasetSettings = z.infer<typeof datasetSettingsSchema>;

export const DATASET_SETTINGS_KEY = 'datasets';

export async function loadDatasetSettings(db: Pool): Promise<DatasetSettings> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    DATASET_SETTINGS_KEY,
  ]);
  return datasetSettingsSchema.parse(rows[0]?.value ?? {});
}
