import { z } from 'zod';

/** A PostgreSQL connection string (postgresql:// or postgres://). */
function postgresUrl(name: string) {
  return z
    .string()
    .min(1, `${name} is required`)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: `${name} must start with postgresql:// or postgres://`,
    });
}

/**
 * All runtime configuration comes from environment variables and is validated here at startup.
 * If anything is missing or invalid, the process refuses to start with a clear message.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
  // Pooled connection used by the running app (API and worker).
  DATABASE_URL: postgresUrl('DATABASE_URL'),
  // Direct (non-pooled) connection used by Prisma CLI and, later, the pg-boss queue.
  DIRECT_URL: postgresUrl('DIRECT_URL'),
  // Signs login tokens. Never share it; rotating it logs everyone out.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Login lifetime in hours (1 hour to 7 days).
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  // true behind a reverse proxy (e.g. Render) so request.ip is the real client IP.
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Google Places API (New). Only required for real searches; never logged.
  GOOGLE_PLACES_API_KEY: z.string().min(10, 'GOOGLE_PLACES_API_KEY looks too short').optional(),
  // Real Google by default; can point to the local mock server for development.
  GOOGLE_PLACES_BASE_URL: z.string().url().default('https://places.googleapis.com'),
  // Real Google requests need an explicit "true" (safety switch).
  GOOGLE_LIVE_REQUESTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Worker: tasks processed in parallel, and idle polling interval.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  WORKER_POLL_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
  // Worker also crawls new websites for emails (same rules as crawl:run). "false" turns it off.
  WORKER_CRAWL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment variables:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/** Parse and validate environment variables. Throws EnvValidationError on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
    );
    throw new EnvValidationError(problems);
  }
  return parsed.data;
}
