import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env automatically. Load backend/.env for CLI commands
// (migrate, generate, studio). Real environment variables always win.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on variables already set in the environment.
}

// Migrations must use the DIRECT (non-pooled) Neon connection.
const directUrl = process.env.DIRECT_URL;
if (!directUrl) {
  throw new Error('DIRECT_URL is not set. Add it to backend/.env (Neon URL without "-pooler").');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: directUrl,
  },
});