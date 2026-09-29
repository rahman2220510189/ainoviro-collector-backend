import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';

/** Crawler settings, stored as JSON in settings.key = "crawler". Spec §9. */
export const crawlerSettingsSchema = z.object({
  /** Pages fetched per website: the homepage plus contact/about/legal pages. */
  maxPagesPerDomain: z.number().int().min(1).max(20).default(5),
  /** Pause between two requests to the same website (polite crawling, at least 1 s). */
  delayMs: z.number().int().min(1000).max(60_000).default(1500),
  /** A robots.txt "Crawl-delay" is respected up to this many seconds. */
  maxCrawlDelaySeconds: z.number().int().min(1).max(60).default(10),
  /** Whole-request time limit. */
  timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
  /** Largest page accepted, after decompression (protects against huge or malicious pages). */
  maxBytes: z.number().int().min(10_000).max(10_000_000).default(5_000_000),
  maxRedirects: z.number().int().min(0).max(5).default(3),
  /** Sent with every request so site owners can see who is visiting. */
  userAgent: z
    .string()
    .min(5)
    .default('ainoviroBot/1.0 (business contact finder; +https://ainoviro.com)'),
  /** Name matched against "User-agent:" lines in robots.txt. */
  robotsToken: z.string().min(1).default('ainoviroBot'),
  /** Websites crawled at the same time by one worker (used from step 2.3). */
  concurrency: z.number().int().min(1).max(20).default(5),
  /** A website where no email was found is tried again after this many days (spec: 90). */
  retryWithoutEmailDays: z.number().int().min(1).max(365).default(90),
});

export type CrawlerSettings = z.infer<typeof crawlerSettingsSchema>;

export const CRAWLER_SETTINGS_KEY = 'crawler';

export async function loadCrawlerSettings(prisma: PrismaClient): Promise<CrawlerSettings> {
  const row = await prisma.setting.findUnique({ where: { key: CRAWLER_SETTINGS_KEY } });
  return crawlerSettingsSchema.parse(row?.value ?? {});
}