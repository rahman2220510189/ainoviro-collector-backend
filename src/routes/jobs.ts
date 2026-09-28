import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { JobService } from '../jobs/job-service';
import { AppError } from '../lib/errors';

export const jobRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  countryCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'countryCode must be 2 letters, e.g. "CY"')
    .transform((code) => code.toUpperCase()),
  districtNames: z.array(z.string().trim().min(1)).max(50).default([]),
  categorySlugs: z.array(z.string().trim().min(1)).max(16).default([]),
  greek: z.boolean().default(false),
  includeRural: z.boolean().optional(),
  minCityPopulation: z.number().int().min(0).optional(),
  forceRerun: z.boolean().default(false),
});

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const actionParamsSchema = idParamsSchema.extend({ action: z.enum(['start', 'pause', 'resume', 'cancel']) });
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** Routes under /api/v1/jobs (login required, enforced by the parent scope). */
export function jobRoutes(service: JobService): FastifyPluginAsync {
  return async (app) => {
    // Dry run: plan + cost, nothing saved.
    app.post('/preview', async (request) => {
      return { preview: await service.preview(jobRequestSchema.parse(request.body)) };
    });

    app.post('/', async (request, reply) => {
      const created = await service.create(jobRequestSchema.parse(request.body), request.adminUser?.id);
      return reply.status(201).send(created);
    });

    app.get('/', async (request) => {
      const { limit } = listQuerySchema.parse(request.query);
      return { jobs: await service.list(limit) };
    });

    app.get('/:id', async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const job = await service.get(id);
      if (!job) throw new AppError(404, 'JOB_NOT_FOUND', `Job ${id} not found`);
      return { job };
    });

    // POST /api/v1/jobs/:id/start | pause | resume | cancel
    app.post('/:id/:action', async (request) => {
      const { id, action } = actionParamsSchema.parse(request.params);
      return { job: await service.act(id, action) };
    });
  };
}