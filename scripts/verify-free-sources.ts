/**
 * Proves against the REAL database the Phase 4 goal: "with Google paused, a job still
 * completes using the free sources". Uses the imported Overture data of Cyprus and the
 * city with the most Overture businesses. Jobs are created in TEST (mock) mode, so a running
 * worker never sends their Google searches, and no Google request is made. The test jobs
 * are deleted at the end; businesses and emails are not changed.
 *
 * Usage: npm run freesources:verify
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { createPrismaClient } from '../src/db/prisma';
import { createPrismaJobService } from '../src/jobs/job-service';
import { MOCK_QUOTA_PROVIDER } from '../src/jobs/keys';
import { hasOvertureData } from '../src/jobs/overture-counts';
import { runOvertureTask } from '../src/jobs/overture-task';
import { claimNextOvertureTask } from '../src/jobs/task-store';
import { createLogger } from '../src/lib/logger';
import { GOOGLE_PROVIDER, GOOGLE_TEXT_SEARCH_SKU, QuotaGuard } from '../src/quota/quota-guard';
import { loadQuotaSettings } from '../src/quota/settings';

const COUNTRY = 'CY';
const NAME = 'verify-free-sources';

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
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 4 });
  const log = createLogger({ ...env, LOG_LEVEL: 'silent' }, 'verify');
  const quota = new QuotaGuard(prisma, await loadQuotaSettings(prisma));
  const service = createPrismaJobService(prisma, { quota, mode: 'MOCK' });

  /** Runs this job's free-data tasks here (a running worker may take some; that is fine). */
  const runFreeTasks = async (jobId: number): Promise<void> => {
    for (;;) {
      const task = await claimNextOvertureTask(db, jobId);
      if (task) {
        await runOvertureTask({ db, log }, task);
        continue;
      }
      const busy = await db.query(
        `SELECT 1 FROM job_tasks WHERE job_id = $1 AND source = 'OVERTURE' AND status = 'RUNNING'`,
        [jobId],
      );
      if (busy.rowCount === 0) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const googleRequests = async (): Promise<number> =>
    (await quota.getUsage(GOOGLE_PROVIDER, GOOGLE_TEXT_SEARCH_SKU)).requestCount +
    (await quota.getUsage(MOCK_QUOTA_PROVIDER, GOOGLE_TEXT_SEARCH_SKU)).requestCount;

  try {
    await prisma.job.deleteMany({ where: { name: { startsWith: NAME } } });
    if (!(await hasOvertureData(prisma, COUNTRY))) {
      throw new Error('No Overture data for CY. Run import:overture and merge:overture first.');
    }
    // The city with the most Overture businesses: a small, quick scope with real data.
    const city = await db.query<{ id: number; name: string; n: number }>(
      `SELECT l.id, l.name, count(p.id)::int AS n
       FROM locations l
       JOIN places p ON p.lat BETWEEN l.bbox_south AND l.bbox_north
                    AND p.lng BETWEEN l.bbox_west AND l.bbox_east
       JOIN place_sources s ON s.place_id = p.id AND s.source = 'OVERTURE'
       WHERE l.country_code = $1 AND l.type = 'CITY' AND l.active
       GROUP BY l.id, l.name ORDER BY n DESC LIMIT 1`,
      [COUNTRY],
    );
    const target = city.rows[0];
    if (!target) throw new Error('No city with Overture businesses. Run merge:overture first.');
    const base = {
      countryCode: COUNTRY,
      districtNames: [],
      locationIds: [target.id],
      categorySlugs: [],
      greek: false,
      includeRural: false,
      forceRerun: true,
    };
    const requestsBefore = await googleRequests();

    // A. Preview with free data only.
    const preview = await service.preview({ ...base, sources: ['OVERTURE'] });
    check(
      'A. "Free data only" plans no Google request and finds known businesses',
      preview.cost.minimum === 0 &&
        preview.overtureTasks > 0 &&
        preview.overtureKnown.businesses > 0,
      `${target.name}: Google requests ${preview.cost.minimum}, free-data areas ${preview.overtureTasks}, ` +
        `businesses ${preview.overtureKnown.businesses} (${preview.overtureKnown.withEmail} with email)`,
    );

    // B. Free-only job runs to the end.
    const free = await service.create({ ...base, sources: ['OVERTURE'], name: `${NAME} A` });
    await service.act(free.jobId, 'start');
    await runFreeTasks(free.jobId);
    const freeJob = await service.get(free.jobId);
    check(
      'B. A free-only job completes and counts the same businesses',
      freeJob?.status === 'COMPLETED' &&
        freeJob.stages.free?.businesses === preview.overtureKnown.businesses &&
        freeJob.stages.search.total === 0,
      `status ${freeJob?.status}, businesses ${freeJob?.stages.free?.businesses}, Google tasks ${freeJob?.stages.search.total}`,
    );

    // C. Mixed job: Google is paused for the quota; free data still runs.
    const mixed = await service.create({
      ...base,
      sources: ['GOOGLE_PLACES', 'OVERTURE'],
      name: `${NAME} B`,
    });
    await service.act(mixed.jobId, 'start');
    await db.query(`UPDATE jobs SET status = 'PAUSED_QUOTA' WHERE id = $1`, [mixed.jobId]);
    await runFreeTasks(mixed.jobId);
    const paused = await service.get(mixed.jobId);
    check(
      'C. While Google is paused for the quota, the free data still runs',
      paused?.status === 'PAUSED_QUOTA' &&
        paused.stages.free?.done === paused.stages.free?.total &&
        (paused.stages.search.toDo ?? 0) > 0,
      `status ${paused?.status}, free ${paused?.stages.free?.done}/${paused?.stages.free?.total}, Google waiting ${paused?.stages.search.toDo}`,
    );

    // D. "Continue with free sources" finishes the job; Google searches wait.
    await service.act(mixed.jobId, 'continue-free');
    const done = await service.get(mixed.jobId);
    check(
      'D. "Continue with free sources" completes the job; Google searches wait for later',
      done?.status === 'COMPLETED' && (done.googleDeferred ?? 0) > 0,
      `status ${done?.status}, Google searches waiting ${done?.googleDeferred}`,
    );

    // E. Later, Resume brings the Google searches back.
    await service.act(mixed.jobId, 'resume');
    const resumed = await service.get(mixed.jobId);
    const pending = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_tasks
       WHERE job_id = $1 AND source = 'GOOGLE_PLACES' AND status = 'PENDING'`,
      [mixed.jobId],
    );
    check(
      'E. Resume puts the waiting Google searches back in line',
      resumed?.status === 'RUNNING' &&
        resumed.googleDeferred === 0 &&
        (pending.rows[0]?.n ?? 0) === done?.googleDeferred,
      `status ${resumed?.status}, Google searches in line ${pending.rows[0]?.n}`,
    );
    await service.act(mixed.jobId, 'cancel');

    const requestsAfter = await googleRequests();
    check(
      'F. No Google request was made',
      requestsAfter === requestsBefore,
      `Google requests this month ${requestsBefore} -> ${requestsAfter}`,
    );
  } finally {
    await prisma.job
      .deleteMany({ where: { name: { startsWith: NAME } } })
      .catch((err: unknown) => console.error('cleanup failed:', err));
    await db.end();
    await prisma.$disconnect();
  }
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
