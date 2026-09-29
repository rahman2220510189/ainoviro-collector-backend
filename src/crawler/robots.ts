import robotsParser from 'robots-parser';
import { fetchPage, FetchError, type FetchOptions } from './fetch-page';

export type RobotsStatus = 'OK' | 'MISSING' | 'UNAVAILABLE';

export interface RobotsRules {
  status: RobotsStatus;
  /** Why the rules are UNAVAILABLE (server error or network problem). */
  reason?: string;
  isAllowed(url: string): boolean;
  /** Crawl-delay for our bot in ms, or null when none is given. */
  crawlDelayMs: number | null;
  /** Sitemap URLs announced in robots.txt. */
  sitemaps: string[];
}

const ALLOW_ALL = (status: RobotsStatus): RobotsRules => ({
  status,
  isAllowed: () => true,
  crawlDelayMs: null,
  sitemaps: [],
});

const DENY_ALL = (reason: string): RobotsRules => ({
  status: 'UNAVAILABLE',
  reason,
  isAllowed: () => false,
  crawlDelayMs: null,
  sitemaps: [],
});

/** Parses robots.txt text for one origin (pure; used by loadRobots and tests). */
export function parseRobots(origin: string, text: string, token: string): RobotsRules {
  const robots = robotsParser(`${origin}/robots.txt`, text);
  const delay = robots.getCrawlDelay(token);
  return {
    status: 'OK',
    // undefined = URL on another host; we only ask about our own host, so treat as allowed.
    isAllowed: (url) => robots.isAllowed(url, token) !== false,
    crawlDelayMs: typeof delay === 'number' && delay > 0 ? delay * 1000 : null,
    sitemaps: robots.getSitemaps(),
  };
}

/**
 * Loads the rules for one origin, following the usual conventions:
 *  - 2xx: obey the file;
 *  - 4xx (no file): everything is allowed;
 *  - 5xx or a temporary network error: the site is treated as fully disallowed
 *    for now (crawl it later), because we cannot know what the owner wants.
 * Permanent problems (unknown domain, private address, bad URL) are thrown, so the
 * caller reports the real reason.
 */
export async function loadRobots(
  origin: string,
  options: FetchOptions,
  token: string,
): Promise<RobotsRules> {
  try {
    const page = await fetchPage(`${origin}/robots.txt`, { ...options, expect: 'text' });
    if (page.status >= 200 && page.status < 300) return parseRobots(origin, page.body, token);
    if (page.status >= 400 && page.status < 500) return ALLOW_ALL('MISSING');
    return DENY_ALL(`robots.txt answered HTTP ${page.status}`);
  } catch (err) {
    if (!(err instanceof FetchError)) throw err;
    // Too many redirects or a huge file: behave as if there were no file.
    if (err.code === 'TOO_MANY_REDIRECTS' || err.code === 'TOO_LARGE') return ALLOW_ALL('MISSING');
    if (err.retryable) return DENY_ALL(err.message);
    throw err;
  }
}