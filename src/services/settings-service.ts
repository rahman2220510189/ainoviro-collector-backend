import type { Pool } from 'pg';
import { z } from 'zod';
import { normalizeBusinessName } from '../cleaning/name';
import { analyzeWebsite } from '../cleaning/website';
import { CRAWLER_SETTINGS_KEY, crawlerSettingsSchema } from '../crawler/settings';
import { runLeadPipeline, withPipelineLock } from '../leads/process';
import { LEAD_RULES_KEY, leadRulesSchema, loadLeadRules } from '../leads/rules';
import { AppError } from '../lib/errors';
import { QUOTA_SETTINGS_KEY, quotaSettingsSchema, type QuotaSettings } from '../quota/settings';
import { SEARCH_SETTINGS_KEY, searchSettingsSchema } from './settings';

/** Safety limits on top of the schemas: a typo must never open the door to big bills. */
export const MAX_FREE_LIMIT = 100_000;
export const MAX_MONTHLY_CAP_EUR = 500;

const quotaInputSchema = quotaSettingsSchema
  .refine((q) => q.freeLimit <= MAX_FREE_LIMIT, {
    message: `freeLimit can be at most ${MAX_FREE_LIMIT}`,
    path: ['freeLimit'],
  })
  .refine((q) => q.monthlyHardCapEur <= MAX_MONTHLY_CAP_EUR, {
    message: `monthlyHardCapEur can be at most ${MAX_MONTHLY_CAP_EUR}`,
    path: ['monthlyHardCapEur'],
  });

/** Each editable section: its settings row and the schema that validates it. */
export const SETTINGS_SECTIONS = {
  quota: { key: QUOTA_SETTINGS_KEY, schema: quotaInputSchema },
  search: { key: SEARCH_SETTINGS_KEY, schema: searchSettingsSchema },
  crawler: { key: CRAWLER_SETTINGS_KEY, schema: crawlerSettingsSchema },
  leadRules: { key: LEAD_RULES_KEY, schema: leadRulesSchema },
} as const;

export type SettingsSection = keyof typeof SETTINGS_SECTIONS;
export const SECTION_NAMES = Object.keys(SETTINGS_SECTIONS) as SettingsSection[];

export interface SectionView {
  /** Effective values (saved values with defaults filled in). */
  values: Record<string, unknown>;
  /** The values used when nothing is saved. */
  defaults: Record<string, unknown>;
  updatedAt: string | null;
}

export interface ChainEntry {
  id: number;
  name: string;
  domain: string | null;
  addedAt: string;
}

export interface AllSettings {
  sections: Record<SettingsSection, SectionView>;
  chains: ChainEntry[];
}

export interface SettingsService {
  getAll(): Promise<AllSettings>;
  /** Validates the whole section, saves it, writes the audit log. */
  update(section: SettingsSection, values: unknown, adminId: number | null): Promise<SectionView>;
  addChain(name: string, domain: string | null, adminId: number | null): Promise<ChainEntry[]>;
  removeChain(id: number, adminId: number | null): Promise<ChainEntry[]>;
}

const toPlain = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

/**
 * Settings page (spec §13: quota, search, crawler, scoring, chain blocklist). Changes
 * apply without a restart: the API reloads the quota guard at once (onQuotaChange) and
 * the worker re-reads settings every minute. Chain and rule changes re-run the lead
 * pipeline for Cyprus straight away, so the counts on every page are current.
 */
export function createSettingsService(
  db: Pool,
  options: { onQuotaChange?: (settings: QuotaSettings) => void; country?: string } = {},
): SettingsService {
  const country = options.country ?? 'CY';

  async function readRow(key: string): Promise<{ value: unknown; updatedAt: Date | null }> {
    const { rows } = await db.query<{ value: unknown; updated_at: Date }>(
      'SELECT value, updated_at FROM settings WHERE key = $1',
      [key],
    );
    return { value: rows[0]?.value ?? {}, updatedAt: rows[0]?.updated_at ?? null };
  }

  async function sectionView(section: SettingsSection): Promise<SectionView> {
    const { key, schema } = SETTINGS_SECTIONS[section];
    const row = await readRow(key);
    // A saved value that no longer passes (e.g. after a schema change) falls back to defaults.
    const parsed = schema.safeParse(row.value);
    return {
      values: toPlain(parsed.success ? parsed.data : schema.parse({})),
      defaults: toPlain(schema.parse({})),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }

  async function listChains(): Promise<ChainEntry[]> {
    const { rows } = await db.query<{
      id: number;
      display_name: string;
      domain: string | null;
      added_at: Date;
    }>('SELECT id, display_name, domain, added_at FROM chain_blocklist ORDER BY display_name');
    return rows.map((r) => ({
      id: r.id,
      name: r.display_name,
      domain: r.domain,
      addedAt: r.added_at.toISOString(),
    }));
  }

  async function audit(
    adminId: number | null,
    action: string,
    entityId: string,
    details: unknown,
  ): Promise<void> {
    await db.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'setting', $3, $4::jsonb)`,
      [adminId, action, entityId, JSON.stringify(details)],
    );
  }

  /** Chains and lead rules change who is exportable: recompute now. */
  async function refreshLeads(): Promise<void> {
    const rules = await loadLeadRules(db);
    await withPipelineLock(db, () => runLeadPipeline(db, country, rules, false));
  }

  return {
    async getAll() {
      const views = await Promise.all(SECTION_NAMES.map((s) => sectionView(s)));
      const sections = Object.fromEntries(SECTION_NAMES.map((s, i) => [s, views[i]])) as Record<
        SettingsSection,
        SectionView
      >;
      return { sections, chains: await listChains() };
    },

    async update(section, values, adminId) {
      const { key, schema } = SETTINGS_SECTIONS[section];
      const result = schema.safeParse(values);
      if (!result.success) {
        throw new AppError(400, 'INVALID_SETTINGS', 'Some values are not allowed.', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const before = (await sectionView(section)).values;
      const after = toPlain(result.data);
      await db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(after)],
      );
      const changed = Object.fromEntries(
        Object.keys(after)
          .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
          .map((k) => [k, { from: before[k], to: after[k] }]),
      );
      await audit(adminId, 'settings.update', key, { changed });

      if (section === 'quota') options.onQuotaChange?.(result.data as QuotaSettings);
      if (section === 'leadRules') await refreshLeads();
      return sectionView(section);
    },

    async addChain(name, domain, adminId) {
      const normalized = normalizeBusinessName(name);
      if (normalized === '') throw new AppError(400, 'INVALID_CHAIN', 'The name is empty.');
      const cleanDomain = domain ? analyzeWebsite(domain).domain : null;
      if (domain && !cleanDomain) {
        throw new AppError(400, 'INVALID_CHAIN', `"${domain}" is not a valid website.`);
      }
      await db.query(
        `INSERT INTO chain_blocklist (name_normalized, display_name, domain) VALUES ($1, $2, $3)
         ON CONFLICT (name_normalized) DO UPDATE
           SET display_name = $2, domain = COALESCE($3, chain_blocklist.domain)`,
        [normalized, name.trim(), cleanDomain],
      );
      await audit(adminId, 'chain.add', normalized, { name: name.trim(), domain: cleanDomain });
      await refreshLeads();
      return listChains();
    },

    async removeChain(id, adminId) {
      const { rows } = await db.query<{ name_normalized: string; display_name: string }>(
        'DELETE FROM chain_blocklist WHERE id = $1 RETURNING name_normalized, display_name',
        [id],
      );
      const removed = rows[0];
      if (!removed) throw new AppError(404, 'CHAIN_NOT_FOUND', `Chain entry ${id} not found`);
      await audit(adminId, 'chain.remove', removed.name_normalized, { name: removed.display_name });
      await refreshLeads();
      return listChains();
    },
  };
}

export const chainInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain: z.string().trim().max(200).optional(),
});
