/**
 * Creates the single admin user from .env, or updates its password if it exists.
 * Idempotent: safe to run again. The .env password is the source of truth.
 *
 * Usage: npm run seed:admin
 */
import { z } from 'zod';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { hashPassword } from '../auth/password';

const adminEnvSchema = z.object({
  ADMIN_EMAIL: z.string().trim().toLowerCase().email('ADMIN_EMAIL must be a valid email'),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters'),
});

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();

  const parsed = adminEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid admin settings in .env:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.map(String).join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = parsed.data;

  const prisma = createPrismaClient(env);
  try {
    const passwordHash = await hashPassword(password);
    const existing = await prisma.adminUser.findUnique({ where: { email }, select: { id: true } });

    const admin = await prisma.adminUser.upsert({
      where: { email },
      create: { email, passwordHash },
      update: { passwordHash },
    });

    await prisma.auditLog.create({
      data: {
        actorId: admin.id,
        action: existing ? 'admin.password_set_by_seed' : 'admin.created_by_seed',
        entityType: 'admin_user',
        entityId: String(admin.id),
      },
    });

    console.log(
      existing
        ? `Admin ${email} already existed: password updated from .env.`
        : `Admin ${email} created.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else {
    console.error('Seeding failed:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});