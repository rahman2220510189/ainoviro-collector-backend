import type { Pool } from 'pg';
import { z } from 'zod';

/**
 * Rules for de-duplication, chain detection, the quality gate and the lead score
 * (spec §10, §11). Stored as JSON in settings.key = "lead_rules"; every value has a
 * default, so an empty or missing row means "spec defaults".
 */
export const leadRulesSchema = z.object({
  dedupe: z
    .object({
      /** Same website domain or same phone counts as the same business only this close (metres). */
      sameKeyMaxMeters: z.number().int().min(0).max(5000).default(300),
      /** Very similar names count as the same business only this close (metres). */
      sameNameMaxMeters: z.number().int().min(0).max(1000).default(200),
      /** 0..1; how similar two names must be (1 = identical after cleaning). */
      nameSimilarity: z.number().min(0.5).max(1).default(0.85),
    })
    .default({ sameKeyMaxMeters: 300, sameNameMaxMeters: 200, nameSimilarity: 0.85 }),
  chains: z
    .object({
      /** The same own website domain on this many distinct places marks them all as a chain. */
      minPlacesPerDomain: z.number().int().min(2).max(100).default(3),
    })
    .default({ minPlacesPerDomain: 3 }),
  quality: z
    .object({
      emailSyntax: z.boolean().default(true),
      /** The primary email's domain must have a working mail server (MX). */
      emailMx: z.boolean().default(true),
      realCity: z.boolean().default(true),
      category: z.boolean().default(true),
      validPhone: z.boolean().default(true),
    })
    .default({
      emailSyntax: true,
      emailMx: true,
      realCity: true,
      category: true,
      validPhone: true,
    }),
  score: z
    .object({
      ownDomainEmail: z.number().int().default(30),
      hasWebsite: z.number().int().default(15),
      validPhone: z.number().int().default(10),
      goodRating: z.number().int().default(10),
      goodRatingMin: z.number().min(0).max(5).default(4.0),
      goodRatingMinCount: z.number().int().min(0).default(5),
      open: z.number().int().default(10),
      chain: z.number().int().default(-50),
      /** The business already sells online (shop, cart or marketplace shop; step 6.3). */
      sellsOnline: z.number().int().default(20),
    })
    .default({
      ownDomainEmail: 30,
      hasWebsite: 15,
      validPhone: 10,
      goodRating: 10,
      goodRatingMin: 4.0,
      goodRatingMinCount: 5,
      open: 10,
      chain: -50,
      sellsOnline: 20,
    }),
});

export type LeadRules = z.infer<typeof leadRulesSchema>;

export const LEAD_RULES_KEY = 'lead_rules';

export const DEFAULT_LEAD_RULES: LeadRules = leadRulesSchema.parse({});

export async function loadLeadRules(db: Pool): Promise<LeadRules> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    LEAD_RULES_KEY,
  ]);
  return leadRulesSchema.parse(rows[0]?.value ?? {});
}
