import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  SECTION_NAMES,
  chainInputSchema,
  type SettingsService,
} from '../services/settings-service';

const sectionParamsSchema = z.object({ section: z.enum(SECTION_NAMES as [string, ...string[]]) });
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const updateBodySchema = z.object({ values: z.record(z.string(), z.unknown()) });

/** Routes under /api/v1/settings (login required, enforced by the parent scope). */
export function settingsRoutes(service: SettingsService): FastifyPluginAsync {
  return async (app) => {
    // Every section with its effective values and defaults, plus the chain blocklist.
    app.get('/', async () => {
      return { settings: await service.getAll() };
    });

    // PUT /api/v1/settings/quota | search | crawler | leadRules  { values: {...} }
    app.put('/:section', async (request) => {
      const { section } = sectionParamsSchema.parse(request.params);
      const { values } = updateBodySchema.parse(request.body);
      return {
        section: await service.update(
          section as (typeof SECTION_NAMES)[number],
          values,
          request.adminUser?.id ?? null,
        ),
      };
    });

    app.post('/chains', async (request) => {
      const { name, domain } = chainInputSchema.parse(request.body);
      return {
        chains: await service.addChain(name, domain || null, request.adminUser?.id ?? null),
      };
    });

    app.delete('/chains/:id', async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      return { chains: await service.removeChain(id, request.adminUser?.id ?? null) };
    });
  };
}
