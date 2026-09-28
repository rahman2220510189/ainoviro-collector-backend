/**
 * Plan, create and control discovery jobs.
 *
 *   npm run job -- preview --country CY [--districts A,B] [--categories slug,slug]
 *                          [--greek] [--skip-rural] [--min-population 5000] [--force-rerun]
 *   npm run job -- create  (same options) [--name "..."]
 *   npm run job -- start|pause|resume|cancel|status --id N
 *   npm run job -- list
 */
import { parseArgs } from 'node:util';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import type { JobRequest } from '../jobs/create-job';
import { createPrismaJobService, type JobPreview, type JobSummary } from '../jobs/job-service';
import { runModeFor } from '../jobs/keys';
import { AppError } from '../lib/errors';
import { QuotaGuard } from '../quota/quota-guard';
import { loadQuotaSettings } from '../quota/settings';

const fmt = (n: number): string => n.toLocaleString('en');
const list = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');

const VERDICT_TEXT = {
  FITS: 'FITS in the free allowance',
  MAY_NOT_FIT: 'MAY NOT FIT: extra pages or splits could exceed it (the job pauses safely if so)',
  DOES_NOT_FIT: 'DOES NOT FIT: the job will pause when free requests run out (resume next month)',
} as const;

function requireId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Missing or invalid --id, e.g. --id 1');
  return id;
}

function printPreview(p: JobPreview): void {
  console.log(`Plan: ${p.scopeLabel}   [mode ${p.mode}]`);
  console.log(`  Search areas: ${p.areas} (absorbed towns: ${p.absorbedTowns}), keywords: ${p.keywordCount}`);
  console.log(
    `  Tasks: ${fmt(p.tasksTotal)} total, ${fmt(p.tasksToRun)} to run, ` +
      `${fmt(p.skippedByCooldown)} skipped by cooldown (${p.cooldownDays} days${p.forceRerun ? ', ignored: force re-run' : ''})`,
  );
  console.log(
    `  Requests: minimum ${fmt(p.cost.minimum)}, estimated ${fmt(p.cost.estimated)} ` +
      `(avg ${p.cost.averagePages} pages), max without splits ${fmt(p.cost.maximumWithoutSplits)}`,
  );
  console.log(`  Free requests left this month (${p.mode}): ${fmt(p.cost.freeRemaining)} -> ${VERDICT_TEXT[p.cost.verdict]}`);
}

function printSummary(j: JobSummary): void {
  const order = ['PENDING', 'RUNNING', 'DONE', 'DEFERRED', 'FAILED', 'SKIPPED'];
  console.log(`Job #${j.id} "${j.name ?? ''}": ${j.status}`);
  if (j.lastError) console.log(`  Last error: ${j.lastError}`);
  console.log(`  Tasks: ${order.map((s) => `${s} ${j.tasks[s] ?? 0}`).join(', ')}`);
  console.log(`  Results returned by searches: ${fmt(j.resultsReturned)}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      id: { type: 'string' },
      country: { type: 'string' },
      districts: { type: 'string' },
      categories: { type: 'string' },
      greek: { type: 'boolean', default: false },
      'skip-rural': { type: 'boolean', default: false },
      'min-population': { type: 'string' },
      'force-rerun': { type: 'boolean', default: false },
      name: { type: 'string' },
    },
  });
  const command = positionals[0];

  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const prisma = createPrismaClient(env);

  const buildRequest = (): JobRequest => {
    const countryCode = (values.country ?? '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error('Missing --country, e.g. --country CY');
    const minPopulation = values['min-population'];
    if (minPopulation !== undefined && (!Number.isInteger(Number(minPopulation)) || Number(minPopulation) < 0)) {
      throw new Error('--min-population must be a whole number');
    }
    return {
      name: values.name,
      countryCode,
      districtNames: list(values.districts),
      categorySlugs: list(values.categories),
      greek: values.greek ?? false,
      includeRural: values['skip-rural'] ? false : undefined,
      minCityPopulation: minPopulation !== undefined ? Number(minPopulation) : undefined,
      forceRerun: values['force-rerun'] ?? false,
    };
  };

  try {
    const quota = new QuotaGuard(prisma, await loadQuotaSettings(prisma));
    const service = createPrismaJobService(prisma, { quota, mode: runModeFor(env.GOOGLE_PLACES_BASE_URL) });

    switch (command) {
      case 'preview':
        printPreview(await service.preview(buildRequest()));
        console.log('(Dry run: nothing was saved.)');
        break;
      case 'create': {
        const { jobId, preview } = await service.create(buildRequest());
        printPreview(preview);
        console.log(`Job #${jobId} created (QUEUED). Start it with: npm run job -- start --id ${jobId}`);
        break;
      }
      case 'start':
      case 'pause':
      case 'resume':
      case 'cancel':
        printSummary(await service.act(requireId(values.id), command));
        if (command === 'start' || command === 'resume') console.log('Make sure a worker is running: npm run worker');
        break;
      case 'status': {
        const job = await service.get(requireId(values.id));
        if (!job) throw new Error('Job not found.');
        printSummary(job);
        console.log(`  New places saved since job start: ${fmt(job.newPlacesSinceStart)}`);
        console.log('  Recent events (UTC):');
        for (const e of job.events.slice(-8)) {
          console.log(`    ${e.createdAt.slice(11, 19)} ${e.level.padEnd(5)} ${e.type}: ${e.message}`);
        }
        break;
      }
      case 'list':
        for (const j of await service.list(20)) {
          console.log(`#${j.id}  ${j.status.padEnd(12)} ${j.createdAt.slice(0, 16)}  ${j.name ?? ''}`);
        }
        break;
      default:
        throw new Error('Unknown command. Use: preview, create, start, pause, resume, cancel, status, list');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError || err instanceof AppError) console.error(err.message);
  else console.error('Job command failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});