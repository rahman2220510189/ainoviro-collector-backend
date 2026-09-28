import { platformKindOfHost } from '../cleaning/platforms';
import { fetchPage, FetchError, type FetchedPage, type FetchOptions } from './fetch-page';
import { findContactLinks, looksJavaScriptRendered, sameSite, type PageKind } from './links';
import { loadRobots, type RobotsRules } from './robots';
import type { CrawlerSettings } from './settings';

export type CrawlSettings = Pick<
  CrawlerSettings,
  | 'maxPagesPerDomain'
  | 'delayMs'
  | 'maxCrawlDelaySeconds'
  | 'timeoutMs'
  | 'maxBytes'
  | 'maxRedirects'
  | 'userAgent'
  | 'robotsToken'
>;

export interface CrawlOptions {
  settings: CrawlSettings;
  /** Replaceable in tests so they do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** ONLY for tests and the local demo site (see FetchOptions.testOrigins). */
  testOrigins?: string[];
}

export interface CrawledPage {
  url: string;
  kind: PageKind;
  html: string;
}

export type CrawlOutcome = 'DONE' | 'ROBOTS_BLOCKED' | 'FAILED';

export interface CrawlError {
  code: string;
  message: string;
  /** true when trying again later makes sense (timeouts, server errors). */
  retryable: boolean;
}

export interface SiteCrawlResult {
  outcome: CrawlOutcome;
  pages: CrawledPage[];
  /** HTTP requests made, robots.txt included (for politeness stats). */
  requests: number;
  /** Origin actually crawled after redirects, e.g. "https://www.shop.cy". */
  finalOrigin: string | null;
  robotsStatus: RobotsRules['status'] | null;
  looksJavaScriptRendered: boolean;
  error: CrawlError | null;
  /** Problems on secondary pages (the crawl still counts as DONE). */
  pageErrors: { url: string; message: string }[];
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function failed(error: CrawlError, extra: Partial<SiteCrawlResult> = {}): SiteCrawlResult {
  return {
    outcome: 'FAILED',
    pages: [],
    requests: 0,
    finalOrigin: null,
    robotsStatus: null,
    looksJavaScriptRendered: false,
    error,
    pageErrors: [],
    ...extra,
  };
}

function robotsBlocked(requests: number, robotsStatus: RobotsRules['status']): SiteCrawlResult {
  return {
    ...failed({ code: 'ROBOTS_BLOCKED', message: '', retryable: false }),
    outcome: 'ROBOTS_BLOCKED',
    requests,
    robotsStatus,
    error: null,
  };
}

function toCrawlError(err: unknown): CrawlError {
  if (err instanceof FetchError)
    return { code: err.code, message: err.message, retryable: err.retryable };
  return {
    code: 'UNEXPECTED',
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
  };
}

function httpError(page: FetchedPage): CrawlError {
  const retryable = page.status === 429 || page.status >= 500;
  return {
    code: `HTTP_${page.status}`,
    message: `Homepage answered HTTP ${page.status}`,
    retryable,
  };
}

/**
 * Crawls ONE website politely and safely:
 *  1. reads robots.txt first and obeys it (our token, Crawl-delay up to a limit);
 *  2. fetches the homepage (switches https <-> http once if the first scheme fails);
 *  3. follows same-site contact/about/legal/privacy links, best first, up to
 *     maxPagesPerDomain pages in total, waiting between requests.
 * Never throws: every problem is reported in the result.
 */
export async function crawlSite(website: string, options: CrawlOptions): Promise<SiteCrawlResult> {
  const { settings } = options;
  const sleep = options.sleep ?? realSleep;
  const fetchOptions: FetchOptions = {
    userAgent: settings.userAgent,
    timeoutMs: settings.timeoutMs,
    maxBytes: settings.maxBytes,
    maxRedirects: settings.maxRedirects,
    expect: 'html',
    testOrigins: options.testOrigins,
  };

  let start: URL;
  try {
    start = new URL(website);
  } catch {
    return failed({ code: 'BAD_URL', message: `Not a valid URL: ${website}`, retryable: false });
  }

  let requests = 0;
  let delayMs = settings.delayMs;
  let lastRequestAt = 0;
  /** Waits so that two requests to the site are at least `delayMs` apart. */
  const politely = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (requests > 0) {
      const wait = lastRequestAt + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    requests += 1;
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  };

  // Try the given scheme first, then the other one (many small sites have broken HTTPS).
  const alternate = new URL(start);
  alternate.protocol = start.protocol === 'https:' ? 'http:' : 'https:';
  const candidates = [start, alternate];

  let robots: RobotsRules | null = null;
  let home: FetchedPage | null = null;
  let used = start;
  // The first scheme's problem is reported: it is the address the source gave us.
  let firstError: CrawlError | null = null;

  for (const candidate of candidates) {
    try {
      robots = await politely(() =>
        loadRobots(candidate.origin, fetchOptions, settings.robotsToken),
      );
      if (robots.status === 'UNAVAILABLE') {
        firstError ??= {
          code: 'ROBOTS_UNAVAILABLE',
          message: robots.reason ?? 'robots.txt unavailable',
          retryable: true,
        };
        continue;
      }
      if (!robots.isAllowed(candidate.toString())) return robotsBlocked(requests, robots.status);
      home = await politely(() => fetchPage(candidate.toString(), fetchOptions));
      used = candidate;
      break;
    } catch (err) {
      const error = toCrawlError(err);
      firstError ??= error;
      // Permanent problems (unknown domain, private address) will not be fixed by the other scheme.
      if (!error.retryable) break;
    }
  }

  if (!home || !robots) {
    return failed(firstError ?? { code: 'UNEXPECTED', message: 'No response', retryable: true }, {
      requests,
    });
  }
  if (home.status < 200 || home.status >= 300) {
    return failed(httpError(home), { requests, robotsStatus: robots.status });
  }

  const finalUrl = new URL(home.url);
  // The site redirected to Instagram, a booking page, etc.: not an own website.
  const platform = platformKindOfHost(finalUrl.hostname);
  if (platform) {
    return failed(
      {
        code: 'REDIRECTS_TO_PLATFORM',
        message: `Website redirects to a ${platform} page`,
        retryable: false,
      },
      { requests, robotsStatus: robots.status },
    );
  }

  // Redirected to another origin (e.g. shop.cy -> www.shop.com.cy): that origin's robots.txt applies.
  if (finalUrl.origin !== used.origin) {
    try {
      robots = await politely(() =>
        loadRobots(finalUrl.origin, fetchOptions, settings.robotsToken),
      );
    } catch (err) {
      return failed(toCrawlError(err), { requests });
    }
    if (robots.status === 'UNAVAILABLE') {
      return failed(
        {
          code: 'ROBOTS_UNAVAILABLE',
          message: robots.reason ?? 'robots.txt unavailable',
          retryable: true,
        },
        { requests },
      );
    }
    if (!robots.isAllowed(finalUrl.toString())) return robotsBlocked(requests, robots.status);
  }

  if (robots.crawlDelayMs !== null) {
    delayMs = Math.max(
      settings.delayMs,
      Math.min(robots.crawlDelayMs, settings.maxCrawlDelaySeconds * 1000),
    );
  }

  const pages: CrawledPage[] = [{ url: home.url, kind: 'HOME', html: home.body }];
  const pageErrors: SiteCrawlResult['pageErrors'] = [];
  const rules = robots;
  const links = findContactLinks(home.body, home.url).filter((link) => rules.isAllowed(link.url));

  for (const link of links) {
    if (pages.length >= settings.maxPagesPerDomain) break;
    try {
      const page = await politely(() => fetchPage(link.url, fetchOptions));
      if (
        page.status >= 200 &&
        page.status < 300 &&
        sameSite(new URL(page.url).hostname, finalUrl.hostname)
      ) {
        pages.push({ url: page.url, kind: link.kind, html: page.body });
      } else {
        pageErrors.push({ url: link.url, message: `HTTP ${page.status}` });
      }
    } catch (err) {
      pageErrors.push({ url: link.url, message: toCrawlError(err).message });
    }
  }

  return {
    outcome: 'DONE',
    pages,
    requests,
    finalOrigin: finalUrl.origin,
    robotsStatus: robots.status,
    looksJavaScriptRendered: looksJavaScriptRendered(home.body),
    error: null,
    pageErrors,
  };
}