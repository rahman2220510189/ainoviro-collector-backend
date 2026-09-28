import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { splitBbox } from '../adapters/adaptive-search';
import {
  GooglePlacesClient,
  GooglePlacesError,
  QuotaDeniedError,
  type QuotaReserver,
} from '../adapters/google-places';
import { COOLDOWN_NOTE, MAX_SPLIT_DEPTH, queryLogTileKey, tileBox } from './keys';
import { writeGooglePlaces } from './place-writer';
import * as store from './task-store';
import type { ClaimedTask } from './task-store';

export interface DiscoveryContext {
  db: Pool;
  quota: QuotaReserver;
  apiKey: string;
  baseUrl: string;
  quotaProvider: string;
  /** 0 disables the cooldown. */
  cooldownDays: number;
  log: Logger;
}

/**
 * Runs ONE discovery task: skip it if the same search ran within the cooldown;
 * otherwise search (all pages), save places, split the tile if it hit 60 results,
 * log the query and mark the task done. Quota refusal pauses the job; a permanent
 * Google error (e.g. bad key) fails the job; other errors fail only this task.
 */
export async function runDiscoveryTask(ctx: DiscoveryContext, task: ClaimedTask): Promise<void> {
  const tileKey = queryLogTileKey(task.tile.mode, task.tile.areaKey, task.tile.path);

  try {
    const coolingDown =
      !task.tile.forceRerun &&
      ctx.cooldownDays > 0 &&
      (await store.isInCooldown(ctx.db, {
        tileKey,
        keyword: task.keyword,
        language: task.language,
        days: ctx.cooldownDays,
      }));

    if (coolingDown) {
      await store.skipTask(ctx.db, task.id, COOLDOWN_NOTE);
      ctx.log.info({ taskId: task.id, keyword: task.keyword, tile: tileKey }, 'Task skipped (cooldown)');
    } else {
      const client = new GooglePlacesClient({
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        quota: ctx.quota,
        jobId: task.jobId,
        quotaProvider: ctx.quotaProvider,
      });
      const result = await client.searchQuery({
        textQuery: task.keyword,
        languageCode: task.language,
        regionCode: task.tile.countryCode.toLowerCase(),
        bbox: tileBox(task.tile),
      });

      const written = await writeGooglePlaces(ctx.db, result.places, {
        countryCode: task.tile.countryCode,
        cityId: task.tile.cityId,
        subcategoryId: task.subcategoryId,
        keyword: task.keyword,
      });

      if (result.saturated && task.depth < MAX_SPLIT_DEPTH) {
        const created = await store.createChildTasks(ctx.db, task, splitBbox(tileBox(task.tile)));
        await store.addEvent(ctx.db, task.jobId, 'INFO', 'tile_split',
          `"${task.keyword}" hit 60 results in ${task.tile.areaKey}; split into ${created} smaller tiles`,
          { taskId: task.id, depth: task.depth + 1 });
      } else if (result.saturated) {
        await store.addEvent(ctx.db, task.jobId, 'WARN', 'tile_full_at_max_depth',
          `"${task.keyword}" still hit 60 results at the smallest tile size; some places may be missing`,
          { taskId: task.id });
      }

      await store.logQuery(ctx.db, {
        locationId: task.locationId,
        tileKey,
        keyword: task.keyword,
        language: task.language,
        results: result.places.length,
        pages: result.pages,
      });
      await store.completeTask(ctx.db, task.id, result.places.length);

      ctx.log.info(
        { taskId: task.id, keyword: task.keyword, area: task.tile.areaKey, tile: task.tile.path || 'root',
          results: result.places.length, new: written.inserted, pages: result.pages },
        'Task done',
      );
    }
  } catch (err) {
    if (err instanceof QuotaDeniedError) {
      await store.deferTask(ctx.db, task.id);
      if (await store.pauseJobForQuota(ctx.db, task.jobId)) {
        await store.addEvent(ctx.db, task.jobId, 'WARN', 'job_paused_quota',
          `Job paused by the quota guard: ${err.reason}`, { reason: err.reason });
      }
      ctx.log.warn({ taskId: task.id, reason: err.reason }, 'Quota refused: job paused');
    } else if (err instanceof GooglePlacesError && !err.retryable) {
      await store.failTask(ctx.db, task.id, err.message);
      if (await store.failJob(ctx.db, task.jobId, err.message)) {
        await store.addEvent(ctx.db, task.jobId, 'ERROR', 'job_failed', err.message, { httpStatus: err.httpStatus });
      }
      ctx.log.error({ taskId: task.id, err: err.message }, 'Permanent Google error: job failed');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await store.failTask(ctx.db, task.id, message);
      await store.addEvent(ctx.db, task.jobId, 'ERROR', 'task_failed', `Task ${task.id} ("${task.keyword}") failed: ${message}`);
      ctx.log.error({ taskId: task.id, err: message }, 'Task failed');
    }
  }

  if (await store.maybeCompleteJob(ctx.db, task.jobId)) {
    await store.addEvent(ctx.db, task.jobId, 'INFO', 'job_completed', 'All tasks finished');
    ctx.log.info({ jobId: task.jobId }, 'Job completed');
  }
}