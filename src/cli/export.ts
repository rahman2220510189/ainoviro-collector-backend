/**
 * One-click CSV export from the command line (the same code the API uses). Files are
 * written to backend/data/exports/ (never committed: data/ is in .gitignore).
 *
 *   npm run export -- --preview                   how many rows the next export would have
 *   npm run export                                export new rows (mailer_v1), mark them exported
 *   npm run export -- --profile full --scope all  every exportable row, all fields
 *   npm run export -- --city Limassol --limit 50  with filters (also --category, --subcategory, --min-score)
 *   npm run export -- --batches                   list earlier exports
 *   npm run export -- --download 3                write batch 3 again
 *   npm run export -- --undo 3                    return batch 3's rows to "new"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import {
  createExportService,
  exportFiltersSchema,
  exportRequestSchema,
  type ExportFile,
} from '../export/export-service';
import { AppError } from '../lib/errors';

const OUT_DIR = join('data', 'exports');

function save(file: ExportFile): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, file.filename);
  writeFileSync(path, file.csv, 'utf8');
  return path;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      preview: { type: 'boolean', default: false },
      batches: { type: 'boolean', default: false },
      download: { type: 'string' },
      undo: { type: 'string' },
      profile: { type: 'string' },
      scope: { type: 'string' },
      country: { type: 'string' },
      city: { type: 'string' },
      category: { type: 'string' },
      subcategory: { type: 'string' },
      'min-score': { type: 'string' },
      limit: { type: 'string' },
    },
  });
  const filterInput = {
    country: values.country,
    city: values.city,
    category: values.category,
    subcategory: values.subcategory,
    minScore: values['min-score'],
    limit: values.limit,
  };
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 3 });
  const service = createExportService(db);

  try {
    if (values.batches) {
      const batches = await service.listBatches(30);
      console.log(`\nExport batches (latest ${batches.length}):`);
      for (const b of batches)
        console.log(
          `  #${b.id}  ${b.createdAt.toISOString().slice(0, 16).replace('T', ' ')}  ${String(b.rowCount).padStart(4)} rows  ` +
            `${b.profile}/${b.scope}  ${b.status}${b.undoneAt ? ' (undone)' : ''}  ${b.filename}`,
        );
      return;
    }
    if (values.download) {
      const file = await service.download(Number(values.download));
      if (!file) throw new Error(`Batch ${values.download} not found`);
      console.log(`Batch #${values.download}: ${file.rowCount} rows -> ${save(file)}`);
      return;
    }
    if (values.undo) {
      const result = await service.undo(Number(values.undo), null);
      console.log(
        `Batch #${result.batchId} undone: ${result.returned} row(s) back to "new", ` +
          `${result.kept} kept (their status changed after the export).`,
      );
      return;
    }

    const preview = await service.preview(exportFiltersSchema.parse(filterInput));
    if (values.preview) {
      console.log(`\nNew rows ready to export: ${preview.newRows}`);
      console.log(`Held back, need review:   ${preview.needsReview}`);
      console.log('(numbers before "places:process"; the export refreshes them first)');
      return;
    }

    const request = exportRequestSchema.parse({
      ...filterInput,
      profile: values.profile,
      scope: values.scope,
    });
    const file = await service.exportCsv(request, null);
    const path = save(file);
    console.log(`\nExported ${file.rowCount} row(s) -> ${path}`);
    console.log(
      file.batchId === null
        ? 'No new rows: nothing was marked (the file has only the header, or only old rows).'
        : `Batch #${file.batchId} created; these rows will not come again in a "new" export.`,
    );
    if (file.batchId !== null)
      console.log(`Undo if needed: npm run export -- --undo ${file.batchId}`);
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else if (err instanceof AppError) console.error(`${err.code}: ${err.message}`);
  else console.error('Export failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});