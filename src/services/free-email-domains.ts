import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';

const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export const freeEmailDomainsFileSchema = z
  .object({
    version: z.literal(1),
    domains: z
      .array(z.string().regex(DOMAIN_PATTERN, 'domain must be lowercase, e.g. "gmail.com"'))
      .min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.domains.forEach((domain, i) => {
      if (seen.has(domain)) {
        ctx.addIssue({ code: 'custom', path: ['domains', i], message: `duplicate domain "${domain}"` });
      }
      seen.add(domain);
    });
  });

/** Works from both src/services (tsx) and dist/services (compiled). */
export const FREE_EMAIL_DOMAINS_PATH = path.join(__dirname, '../../seed/free_email_domains.json');

export function loadFreeEmailDomains(filePath: string = FREE_EMAIL_DOMAINS_PATH): string[] {
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return freeEmailDomainsFileSchema.parse(JSON.parse(text) as unknown).domains;
}

export interface FreeDomainSyncResult {
  added: number;
  removed: number;
  total: number;
}

/** Makes the table match the file exactly (idempotent). */
export async function syncFreeEmailDomains(
  prisma: PrismaClient,
  domains: string[],
): Promise<FreeDomainSyncResult> {
  const added = await prisma.freeEmailDomain.createMany({
    data: domains.map((domain) => ({ domain })),
    skipDuplicates: true,
  });
  const removed = await prisma.freeEmailDomain.deleteMany({
    where: { domain: { notIn: domains } },
  });
  const total = await prisma.freeEmailDomain.count();
  return { added: added.count, removed: removed.count, total };
}