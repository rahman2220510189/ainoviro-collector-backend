import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { crawlSite, type CrawlSettings } from '../src/crawler/crawl-site';
import { detectCharset, fetchPage, FetchError, type FetchOptions } from '../src/crawler/fetch-page';
import { isBlockedAddress } from '../src/crawler/ip-guard';
import { findContactLinks, looksJavaScriptRendered } from '../src/crawler/links';
import { parseRobots } from '../src/crawler/robots';
import { crawlerSettingsSchema } from '../src/crawler/settings';
import {
  createTestWebsite,
  type TestWebsite,
  type TestWebsiteOptions,
} from '../src/dev/test-website';

let site: TestWebsite | undefined;

afterEach(async () => {
  await site?.app.close();
  site = undefined;
});

async function startSite(options: TestWebsiteOptions = {}): Promise<string> {
  site = createTestWebsite(options);
  await site.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = site.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SETTINGS: CrawlSettings = crawlerSettingsSchema.parse({});

function fetchOptions(origin: string, extra: Partial<FetchOptions> = {}): FetchOptions {
  return {
    userAgent: SETTINGS.userAgent,
    timeoutMs: 2000,
    maxBytes: SETTINGS.maxBytes,
    maxRedirects: SETTINGS.maxRedirects,
    expect: 'html',
    testOrigins: [origin],
    ...extra,
  };
}

/** Records every requested pause instead of really waiting. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe('SSRF guard', () => {
  it('blocks private, loopback, link-local and reserved addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.5.4',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('refuses private targets before connecting, by IP, by name and by scheme', async () => {
    const options = fetchOptions('http://unused.test');
    const codeOf = (url: string) =>
      fetchPage(url, options).then(
        () => 'fetched',
        (err: FetchError) => err.code,
      );
    expect(await codeOf('http://127.0.0.1/')).toBe('BLOCKED_ADDRESS');
    expect(await codeOf('http://169.254.169.254/latest/meta-data/')).toBe('BLOCKED_ADDRESS');
    expect(await codeOf('http://[::1]/')).toBe('BLOCKED_ADDRESS');
    expect(await codeOf('http://localhost/')).toBe('BLOCKED_ADDRESS');
    expect(await codeOf('http://example.com:22/')).toBe('BLOCKED_PORT');
    expect(await codeOf('ftp://example.com/')).toBe('BAD_URL');
  });

  it('checks redirect targets too', async () => {
    const origin = await startSite();
    const error = await fetchPage(`${origin}/redirect-private`, fetchOptions(origin)).catch(
      (err: FetchError) => err,
    );
    expect((error as FetchError).code).toBe('BLOCKED_ADDRESS');
  });
});

describe('fetchPage', () => {
  it('follows up to 3 redirects and refuses a 4th', async () => {
    const origin = await startSite();
    const ok = await fetchPage(`${origin}/redirect/2`, fetchOptions(origin));
    expect(ok.status).toBe(200);
    expect(ok.url).toBe(`${origin}/`);
    expect(ok.redirects).toHaveLength(3);
    const error = await fetchPage(`${origin}/redirect/3`, fetchOptions(origin)).catch(
      (err: FetchError) => err,
    );
    expect((error as FetchError).code).toBe('TOO_MANY_REDIRECTS');
  });

  it('decompresses gzip and decodes old Greek (windows-1253) pages', async () => {
    const origin = await startSite();
    expect((await fetchPage(`${origin}/gzip`, fetchOptions(origin))).body).toContain(
      'compressed page',
    );
    const greek = await fetchPage(
      `${origin}/el/${encodeURIComponent('σχετικά')}`,
      fetchOptions(origin),
    );
    expect(greek.body).toContain('Κομμωτήριο Άννα, Λεμεσός');
  });

  it('stops huge pages, slow pages and non-HTML files', async () => {
    const origin = await startSite();
    const codeOf = (path: string, extra: Partial<FetchOptions> = {}) =>
      fetchPage(`${origin}${path}`, fetchOptions(origin, extra)).then(
        () => 'fetched',
        (err: FetchError) => err.code,
      );
    expect(await codeOf('/huge')).toBe('TOO_LARGE');
    expect(await codeOf('/slow', { timeoutMs: 300 })).toBe('TIMEOUT');
    expect(await codeOf('/image.png')).toBe('WRONG_CONTENT_TYPE');
  });

  it('reads the charset from the header first, then from <meta>', () => {
    expect(detectCharset('text/html; charset=ISO-8859-7', Buffer.from(''))).toBe('iso-8859-7');
    expect(detectCharset('text/html', Buffer.from('<meta charset="windows-1253">'))).toBe(
      'windows-1253',
    );
    expect(detectCharset(null, Buffer.from('<p>no charset</p>'))).toBe('utf-8');
  });
});

describe('robots.txt rules', () => {
  const rules = parseRobots(
    'https://shop.cy',
    'User-agent: *\nDisallow: /private/\nCrawl-delay: 4\n\nUser-agent: ainoviroBot\nDisallow: /no-bots/\n',
    'ainoviroBot',
  );

  it('applies the section for our bot', () => {
    expect(rules.isAllowed('https://shop.cy/contact')).toBe(true);
    expect(rules.isAllowed('https://shop.cy/no-bots/page')).toBe(false);
  });

  it('reads Crawl-delay in milliseconds', () => {
    const delayed = parseRobots(
      'https://shop.cy',
      'User-agent: *\nCrawl-delay: 4\n',
      'ainoviroBot',
    );
    expect(delayed.crawlDelayMs).toBe(4000);
  });
});

describe('findContactLinks', () => {
  const html = `
    <a href="/">Home</a><a href="#x">Top</a>
    <a href="/about-us">About</a>
    <a href="https://www.shop.cy/contact">Contact</a>
    <a href="/el/${encodeURIComponent('επικοινωνία')}">ΕΠΙΚΟΙΝΩΝΙΑ</a>
    <a href="/privacy">Privacy policy</a>
    <a href="/menu.pdf">Contact PDF</a>
    <a href="https://other.cy/contact">Partner</a>
    <a href="mailto:a@shop.cy">Contact</a>
    <a href="/about-us#team">About us again</a>`;

  it('keeps same-site contact pages first, then about, then privacy, without duplicates', () => {
    expect(findContactLinks(html, 'https://shop.cy/')).toEqual([
      { url: 'https://www.shop.cy/contact', kind: 'CONTACT' },
      { url: `https://shop.cy/el/${encodeURIComponent('επικοινωνία')}`, kind: 'CONTACT' },
      { url: 'https://shop.cy/about-us', kind: 'ABOUT' },
      { url: 'https://shop.cy/privacy', kind: 'PRIVACY' },
    ]);
  });

  it('recognizes a JavaScript-only page shell', () => {
    expect(
      looksJavaScriptRendered(
        '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
      ),
    ).toBe(true);
    expect(
      looksJavaScriptRendered(`<html><body><p>${'Real text. '.repeat(40)}</p></body></html>`),
    ).toBe(false);
  });
});

describe('crawlSite', () => {
  it('reads robots.txt, then the homepage, then contact pages, politely and within the page limit', async () => {
    const origin = await startSite();
    const timer = fakeSleep();
    const result = await crawlSite(`${origin}/`, {
      settings: SETTINGS,
      sleep: timer.sleep,
      testOrigins: [origin],
    });

    expect(result.outcome).toBe('DONE');
    expect(result.robotsStatus).toBe('OK');
    expect(result.pages.map((p) => [new URL(p.url).pathname, p.kind])).toEqual([
      ['/', 'HOME'],
      ['/contact', 'CONTACT'],
      [`/el/${encodeURIComponent('σχετικά')}`, 'ABOUT'],
      ['/terms', 'LEGAL'],
      ['/privacy-policy', 'PRIVACY'],
    ]);
    // robots.txt + 5 pages, with a pause before every request after the first.
    expect(result.requests).toBe(6);
    expect(timer.waits).toHaveLength(5);
    for (const wait of timer.waits) expect(wait).toBeGreaterThan(SETTINGS.delayMs - 100);
    // Forbidden, external and file links were never requested.
    expect(site?.hits.get('/private/team')).toBeUndefined();
    expect(site?.hits.get('/brochure.pdf')).toBeUndefined();
    expect(site?.hits.get('/services')).toBeUndefined();
  });

  it('respects maxPagesPerDomain', async () => {
    const origin = await startSite();
    const result = await crawlSite(`${origin}/`, {
      settings: { ...SETTINGS, maxPagesPerDomain: 2 },
      sleep: fakeSleep().sleep,
      testOrigins: [origin],
    });
    expect(result.pages.map((p) => p.kind)).toEqual(['HOME', 'CONTACT']);
  });

  it('does not crawl a site whose robots.txt forbids our bot', async () => {
    const origin = await startSite({ robotsTxt: 'User-agent: ainoviroBot\nDisallow: /\n' });
    const result = await crawlSite(`${origin}/`, {
      settings: SETTINGS,
      sleep: fakeSleep().sleep,
      testOrigins: [origin],
    });
    expect(result.outcome).toBe('ROBOTS_BLOCKED');
    expect(result.pages).toEqual([]);
    expect(site?.hits.get('/')).toBeUndefined();
  });

  it('crawls normally when there is no robots.txt, and uses a longer Crawl-delay', async () => {
    const origin = await startSite({ robotsTxt: null });
    const result = await crawlSite(`${origin}/`, {
      settings: SETTINGS,
      sleep: fakeSleep().sleep,
      testOrigins: [origin],
    });
    expect(result.outcome).toBe('DONE');
    expect(result.robotsStatus).toBe('MISSING');

    await site?.app.close();
    const slowOrigin = await startSite({ robotsTxt: 'User-agent: *\nCrawl-delay: 5\n' });
    const timer = fakeSleep();
    await crawlSite(`${slowOrigin}/`, {
      settings: SETTINGS,
      sleep: timer.sleep,
      testOrigins: [slowOrigin],
    });
    expect(Math.max(...timer.waits)).toBeGreaterThan(4900);
  });

  it('postpones a site whose robots.txt answers with a server error', async () => {
    const origin = await startSite({ robotsStatus: 503 });
    const result = await crawlSite(`${origin}/`, {
      settings: SETTINGS,
      sleep: fakeSleep().sleep,
      testOrigins: [origin],
    });
    expect(result.outcome).toBe('FAILED');
    expect(result.error).toMatchObject({ code: 'ROBOTS_UNAVAILABLE', retryable: true });
    expect(site?.hits.get('/')).toBeUndefined();
  });

  it('reports a failing homepage without throwing', async () => {
    const origin = await startSite();
    const result = await crawlSite(`${origin}/server-error`, {
      settings: SETTINGS,
      sleep: fakeSleep().sleep,
      testOrigins: [origin],
    });
    expect(result.outcome).toBe('FAILED');
    expect(result.error).toMatchObject({ code: 'HTTP_503', retryable: true });

    const unknown = await crawlSite('not a url', { settings: SETTINGS, sleep: fakeSleep().sleep });
    expect(unknown.error).toMatchObject({ code: 'BAD_URL', retryable: false });
  });

  it('never reaches a private address in production mode', async () => {
    const origin = await startSite();
    // No testOrigins: the local test site itself counts as private.
    const result = await crawlSite(`${origin}/`, { settings: SETTINGS, sleep: fakeSleep().sleep });
    expect(result.outcome).toBe('FAILED');
    expect(site?.hits.size).toBe(0);
  });
});