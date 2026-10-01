import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { DashboardService } from '../services/dashboard-service';

const querySchema = z.object({
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'country must be 2 letters, e.g. "CY"')
    .transform((c) => c.toUpperCase())
    .default('CY'),
});

/** Routes under /api/v1/dashboard (login required, enforced by the parent scope). */
export function dashboardRoutes(service: DashboardService): FastifyPluginAsync {
  return async (app) => {
    // GET /api/v1/dashboard?country=CY -> every number on the dashboard page in one call.
    app.get('/', async (request) => {
      const { country } = querySchema.parse(request.query);
      return { dashboard: await service.summary(country) };
    });
  };
}
