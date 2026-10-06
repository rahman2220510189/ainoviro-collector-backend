/**
 * Checks against the REAL database the country setup of step 6.2: the country list,
 * the CSV safety switch per country (a country nobody switched on can never be exported)
 * and the place words used to match duplicate names. Settings are put back at the end.
 *
 * Usage: npm run countries:verify
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { createExportService } from '../src/export/export-service';
import { countryPlaceWords } from '../src/leads/process';
import {
  COUNTRIES_SETTINGS_KEY,
  createCountryService,
  isExportEnabled,
} from '../src/services/country-service';

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 4 });
  const saved = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    COUNTRIES_SETTINGS_KEY,
  ]);
  try {
    const service = createCountryService(db);
    const list = await service.list();
    const cy = list.find((c) => c.code === 'CY');
    const mt = list.find((c) => c.code === 'MT');
    check(
      'A. Cyprus is in use with CSV allowed; other countries are listed, ready to add',
      list.length === 30 && cy?.imported === true && cy.exportEnabled && mt !== undefined,
      `${list.length} countries; Cyprus: ${cy?.places} places, ${cy?.readyLeads} ready leads; Malta in use: ${mt?.imported}`,
    );

    // Switch Malta off on purpose, then try to export it.
    await service.setExport('MT', false, null);
    const exporter = createExportService(db);
    let refused = '';
    try {
      await exporter.exportCsv(
        { country: 'MT', profile: 'mailer_v1', scope: 'new' } as never,
        null,
      );
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    await service.setExport('MT', true, null);
    const on = await isExportEnabled(db, 'MT');
    check(
      'B. A country whose CSV switch is off can never be exported; switching it on works',
      refused.includes('switched off') && on,
      `refused: "${refused.slice(0, 70)}"; switched on afterwards: ${on}`,
    );

    const words = await countryPlaceWords(db, 'CY');
    check(
      'C. Place words for duplicate matching come from the country (English and local names)',
      words.has('limassol') && words.has('nicosia') && words.has('λεμεσος'),
      `${words.size} words, e.g. ${[...words].slice(0, 6).join(', ')}`,
    );
  } finally {
    const before = saved.rows[0];
    if (before) {
      await db.query('UPDATE settings SET value = $2::jsonb, updated_at = now() WHERE key = $1', [
        COUNTRIES_SETTINGS_KEY,
        JSON.stringify(before.value),
      ]);
    } else {
      await db.query('DELETE FROM settings WHERE key = $1', [COUNTRIES_SETTINGS_KEY]);
    }
    await db.query(
      `DELETE FROM audit_log WHERE action = 'country.export' AND entity_id = 'MT'
         AND created_at > now() - interval '5 minutes'`,
    );
    await db.end();
  }
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
