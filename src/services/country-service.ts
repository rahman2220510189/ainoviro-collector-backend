import type { Pool } from 'pg';
import { z } from 'zod';
import { requestRefresh, type RefreshState } from '../datasets/refresh';
import { loadAllCountryConfigs } from '../geonames/config';
import { countReadyLeads } from '../leads/process';
import { AppError } from '../lib/errors';

/**
 * Countries (step 6.2). Technical settings per country live in seed/countries.json
 * (languages, city sizes); what the team switches on the website lives in the database
 * (settings key "countries"): whether leads of a country may go into a CSV at all.
 * Cyprus is allowed by default; every other country starts switched off, so leads of a
 * country nobody approved can never be exported by mistake.
 */
export const COUNTRIES_SETTINGS_KEY = 'countries';

const countrySwitchesSchema = z.record(
  z.string().regex(/^[A-Z]{2}$/),
  z.object({ exportEnabled: z.boolean() }),
);
type CountrySwitches = z.infer<typeof countrySwitchesSchema>;

/** Cyprus was the only country before step 6.2 and keeps working as before. */
const DEFAULT_EXPORT: Record<string, boolean> = { CY: true };

export interface CountryView {
  code: string;
  name: string;
  /** In the location tree (GeoNames imported): jobs and imports can use it. */
  imported: boolean;
  exportEnabled: boolean;
  /** Languages of search keywords, e.g. ["en", "el"]. */
  languages: string[];
  places: number;
  readyLeads: number;
  /** Newest successful Overture import, if any. */
  overtureRelease: string | null;
}

export interface CountryService {
  list(): Promise<CountryView[]>;
  setExport(code: string, enabled: boolean, adminId: number | null): Promise<CountryView[]>;
  /** Imports the country's cities and Overture businesses through the worker. */
  add(code: string, adminId: number | null): Promise<RefreshState>;
}

export async function loadCountrySwitches(db: Pool): Promise<CountrySwitches> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    COUNTRIES_SETTINGS_KEY,
  ]);
  const parsed = countrySwitchesSchema.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : {};
}

export async function isExportEnabled(db: Pool, code: string): Promise<boolean> {
  const switches = await loadCountrySwitches(db);
  return switches[code]?.exportEnabled ?? DEFAULT_EXPORT[code] ?? false;
}

export function createCountryService(db: Pool): CountryService {
  const configs = loadAllCountryConfigs();

  const unknownCountry = (code: string): AppError =>
    new AppError(404, 'COUNTRY_NOT_CONFIGURED', `Country ${code} is not in seed/countries.json.`);

  async function list(): Promise<CountryView[]> {
    const [switches, imported, places, overture] = await Promise.all([
      loadCountrySwitches(db),
      db.query<{ country_code: string; name: string }>(
        `SELECT country_code, name FROM locations WHERE type = 'COUNTRY' AND active`,
      ),
      db.query<{ country_code: string; n: string }>(
        'SELECT country_code, count(*) AS n FROM places GROUP BY country_code',
      ),
      db.query<{ country_code: string; release: string }>(
        `SELECT DISTINCT ON (country_code) country_code, release FROM dataset_imports
         WHERE source = 'OVERTURE' AND status = 'DONE' AND release NOT IN ('local', 'fixture')
         ORDER BY country_code, id DESC`,
      ),
    ]);
    const importedNames = new Map(imported.rows.map((r) => [r.country_code, r.name]));
    const placeCount = new Map(places.rows.map((r) => [r.country_code, Number(r.n)]));
    const release = new Map(overture.rows.map((r) => [r.country_code, r.release]));
    const views: CountryView[] = [];
    for (const [code, config] of Object.entries(configs)) {
      const isImported = importedNames.has(code);
      const count = placeCount.get(code) ?? 0;
      views.push({
        code,
        name: importedNames.get(code) ?? config.name,
        imported: isImported,
        exportEnabled: switches[code]?.exportEnabled ?? DEFAULT_EXPORT[code] ?? false,
        languages: config.keywordLanguages,
        places: count,
        readyLeads: count > 0 ? await countReadyLeads(db, code) : 0,
        overtureRelease: release.get(code) ?? null,
      });
    }
    // Countries in use first, then the rest by name.
    return views.sort((a, b) =>
      a.imported === b.imported ? a.name.localeCompare(b.name) : a.imported ? -1 : 1,
    );
  }

  return {
    list,

    async setExport(code, enabled, adminId) {
      if (!configs[code]) throw unknownCountry(code);
      const switches = await loadCountrySwitches(db);
      switches[code] = { exportEnabled: enabled };
      await db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [COUNTRIES_SETTINGS_KEY, JSON.stringify(switches)],
      );
      await db.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
         VALUES ($1, 'country.export', 'country', $2, $3::jsonb)`,
        [adminId, code, JSON.stringify({ exportEnabled: enabled })],
      );
      return list();
    },

    async add(code, adminId) {
      if (!configs[code]) throw unknownCountry(code);
      return requestRefresh(db, code, adminId);
    },
  };
}
