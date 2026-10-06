import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { CountryService } from '../services/country-service';

const codeParamsSchema = z.object({
  code: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'country code must be 2 letters, e.g. "GR"')
    .transform((c) => c.toUpperCase()),
});
const exportBodySchema = z.object({ exportEnabled: z.boolean() });

/** Routes under /api/v1/countries (login required, enforced by the parent scope). */
export function countryRoutes(service: CountryService): FastifyPluginAsync {
  return async (app) => {
    // Every configured country: in use or not, CSV allowed, places and ready leads.
    app.get('/', async () => {
      return { countries: await service.list() };
    });

    // Switch CSV export of a country on or off.
    app.put('/:code', async (request) => {
      const { code } = codeParamsSchema.parse(request.params);
      const { exportEnabled } = exportBodySchema.parse(request.body);
      return {
        countries: await service.setExport(code, exportEnabled, request.adminUser?.id ?? null),
      };
    });

    // Add a country: the worker imports its cities (GeoNames) and businesses (Overture).
    app.post('/:code/add', async (request, reply) => {
      const { code } = codeParamsSchema.parse(request.params);
      const refresh = await service.add(code, request.adminUser?.id ?? null);
      return reply.status(202).send({ refresh });
    });
  };
}
