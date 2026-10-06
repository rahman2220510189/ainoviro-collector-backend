import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { DatasetService } from '../datasets/dataset-service';

const countryQuerySchema = z.object({
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'country must be 2 letters, e.g. "CY"')
    .transform((c) => c.toUpperCase())
    .default('CY'),
});

/** Routes under /api/v1/datasets (login required, enforced by the parent scope). */
export function datasetRoutes(service: DatasetService): FastifyPluginAsync {
  return async (app) => {
    // Import status, businesses known, update progress.
    app.get('/overture', async (request) => {
      const { country } = countryQuerySchema.parse(request.query);
      return { overture: await service.overtureStatus(country) };
    });

    // Newest release on Overture's servers (cached; never fails the page).
    app.get('/overture/latest', async (request) => {
      const { country } = countryQuerySchema.parse(request.query);
      return { latest: await service.overtureLatest(country) };
    });

    // How the category rules sort the imported places.
    app.get('/overture/report', async (request) => {
      const { country } = countryQuerySchema.parse(request.query);
      return { report: await service.overtureReport(country) };
    });

    // "Update Overture data": the worker downloads, merges and refreshes the leads.
    app.post('/overture/refresh', async (request, reply) => {
      const { country } = countryQuerySchema.parse(request.query);
      const refresh = await service.requestOvertureRefresh(country, request.adminUser?.id ?? null);
      return reply.status(202).send({ refresh });
    });
  };
}
