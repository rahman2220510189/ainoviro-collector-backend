import { describe, expect, it } from 'vitest';
import type { SiteCrawlResult } from '../src/crawler/crawl-site';
import { createTestWebsite, encodeCloudflareEmail } from '../src/dev/test-website';
import { isGenericLocalPart, isOwnDomain, pickPrimaryIndex } from '../src/enrich/classify';
import { evaluateSiteEmails, MAX_EMAILS_PER_SITE } from '../src/enrich/evaluate';
import { decodeCloudflareEmail, deobfuscate, extractEmailsFromPage } from '../src/enrich/extract';
import { isDisposableDomain, rejectReason } from '../src/enrich/filters';
import { MxChecker, type MxResolver } from '../src/enrich/mx';
import { nextRetryDays } from '../src/enrich/save';

const PAGE = 'https://shop.cy/contact';
const emailsOf = (html: string) =>
  extractEmailsFromPage(html, PAGE).map((e) => [e.normalized, e.source]);

describe('extractEmailsFromPage', () => {
  it('reads mailto links, including several addresses and a subject', () => {
    expect(emailsOf('<a href="mailto:Info@Shop.cy,sales@shop.cy?subject=Hi">write</a>')).toEqual([
      ['info@shop.cy', 'mailto'],
      ['sales@shop.cy', 'mailto'],
    ]);
  });

  it('decodes Cloudflare-protected addresses in both forms', () => {
    const hex = encodeCloudflareEmail('bookings@shop.cy');
    expect(decodeCloudflareEmail(hex)).toBe('bookings@shop.cy');
    expect(
      emailsOf(`<span class="__cf_email__" data-cfemail="${hex}">[email protected]</span>`),
    ).toEqual([['bookings@shop.cy', 'cfemail']]);
    expect(emailsOf(`<a href="/cdn-cgi/l/email-protection#${hex}">[email protected]</a>`)).toEqual([
      ['bookings@shop.cy', 'cfemail'],
    ]);
    expect(decodeCloudflareEmail('zz')).toBeNull();
  });

  it('reads "email" fields at any depth of JSON-LD and ignores broken JSON-LD', () => {
    const html =
      '<script type="application/ld+json">{"@type":"LocalBusiness","contactPoint":[{"email":"mailto:hello@shop.cy"}]}</script>' +
      '<script type="application/ld+json">{ broken json</script>';
    expect(emailsOf(html)).toEqual([['hello@shop.cy', 'jsonld']]);
  });

  it('reads visible text with HTML entities first, and scripts last', () => {
    const html =
      '<p>Mail: anna&#64;shop.cy</p><script>var x = "hidden@shop.cy";</script><style>.a{}</style>';
    expect(emailsOf(html)).toEqual([
      ['anna@shop.cy', 'text'],
      ['hidden@shop.cy', 'script'],
    ]);
  });

  it('decodes human obfuscations', () => {
    expect(deobfuscate('maria [at] shop [dot] cy')).toBe('maria@shop.cy');
    expect(deobfuscate('maria(at)shop(dot)com(dot)cy')).toBe('maria@shop.com.cy');
    expect(deobfuscate('maria AT shop DOT cy')).toBe('maria@shop.cy');
    // Ordinary sentences are not touched.
    expect(deobfuscate('meet us at the shop')).toBe('meet us at the shop');
    expect(emailsOf('<p>Owner: maria {at} shop [dot] cy</p>')).toEqual([
      ['maria@shop.cy', 'obfuscated'],
    ]);
  });

  it('finds every kind of address on the demo contact page', async () => {
    const response = await createTestWebsite().app.inject('/contact');
    const found = extractEmailsFromPage(response.body, PAGE).map((e) => e.normalized);
    expect(found).toEqual(
      expect.arrayContaining([
        'info@anna-beauty.test',
        'maria@anna-beauty.test',
        'bookings@anna-beauty.test',
        'hello@anna-beauty.test',
        'anna.accounts@gmail.com',
      ]),
    );
  });
});

describe('false positive filter', () => {
  it.each([
    ['logo@2x.png', 'FILE_NAME'],
    ['icon@3x.webp', 'FILE_NAME'],
    ['name@example.com', 'PLACEHOLDER'],
    ['info@yourdomain.com', 'PLACEHOLDER'],
    ['abc@sentry.io', 'TECH_DOMAIN'],
    ['x@sentry-next.wixpress.com', 'TECH_DOMAIN'],
    ['info@instagram.com', 'PLATFORM_DOMAIN'],
    ['noreply@shop.cy', 'JUNK_LOCAL'],
    ['no-reply@shop.cy', 'JUNK_LOCAL'],
    ['0123456789abcdef0123@shop.cy', 'HASH_LOCAL'],
  ])('rejects %s (%s)', (email, reason) => {
    expect(rejectReason(email)).toBe(reason);
  });

  it('keeps real business addresses', () => {
    for (const email of [
      'info@shop.cy',
      'maria@gmail.com',
      'email@mail.com',
      'sales@cytanet.com.cy',
    ]) {
      expect(rejectReason(email), email).toBeNull();
    }
  });

  it('knows disposable mailbox domains', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('gmail.com')).toBe(false);
  });
});

describe('classification', () => {
  it('flags role addresses as generic', () => {
    for (const email of [
      'info@x.cy',
      'info.limassol@x.cy',
      'sales2@x.cy',
      'hello+web@x.cy',
      'bookings@x.cy',
    ]) {
      expect(isGenericLocalPart(email), email).toBe(true);
    }
    for (const email of [
      'maria@x.cy',
      'a.georgiou@x.cy',
      'information.desk.maria@x.cy',
      'infomaria@x.cy',
    ]) {
      expect(isGenericLocalPart(email), email).toBe(false);
    }
  });

  it('recognizes the own domain, including subdomains', () => {
    expect(isOwnDomain('shop.cy', 'shop.cy')).toBe(true);
    expect(isOwnDomain('mail.shop.cy', 'shop.cy')).toBe(true);
    expect(isOwnDomain('shop.cy', 'limassol.shop.cy')).toBe(true);
    expect(isOwnDomain('gmail.com', 'shop.cy')).toBe(false);
    expect(isOwnDomain('shop.cy', null)).toBe(false);
  });

  it('picks own domain first, then personal, and never an address without a mail server', () => {
    const generic = { isOwnDomain: true, emailType: 'GENERIC' as const, mxValid: true };
    const personalOwn = { isOwnDomain: true, emailType: 'PERSONAL' as const, mxValid: true };
    const personalGmail = { isOwnDomain: false, emailType: 'PERSONAL' as const, mxValid: true };
    const deadOwn = { isOwnDomain: true, emailType: 'PERSONAL' as const, mxValid: false };
    expect(pickPrimaryIndex([generic, personalGmail, personalOwn])).toBe(2);
    expect(pickPrimaryIndex([personalGmail, generic])).toBe(1);
    expect(pickPrimaryIndex([deadOwn, personalGmail])).toBe(1);
    // Ties keep the order found on the site.
    expect(pickPrimaryIndex([generic, { ...generic }])).toBe(0);
    expect(pickPrimaryIndex([])).toBe(-1);
  });
});

describe('MxChecker', () => {
  it('caches answers and understands missing domains and "null MX"', async () => {
    const calls: string[] = [];
    const resolver: MxResolver = async (domain) => {
      calls.push(domain);
      if (domain === 'shop.cy') return [{ exchange: 'mail.shop.cy', priority: 10 }];
      if (domain === 'nullmx.cy') return [{ exchange: '', priority: 0 }];
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    };
    const mx = new MxChecker(resolver);
    expect(await mx.check('shop.cy')).toBe(true);
    expect(await mx.check('SHOP.cy')).toBe(true);
    expect(await mx.check('nullmx.cy')).toBe(false);
    expect(await mx.check('missing.cy')).toBe(false);
    expect(calls).toEqual(['shop.cy', 'nullmx.cy', 'missing.cy']);
  });

  it('returns "unknown" on a DNS timeout and asks again next time', async () => {
    let calls = 0;
    const mx = new MxChecker(async () => {
      calls += 1;
      throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    });
    expect(await mx.check('slow.cy')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await mx.check('slow.cy')).toBeNull();
    expect(calls).toBe(2);
  });
});

describe('evaluateSiteEmails', () => {
  const mx = new MxChecker(async () => [{ exchange: 'mx.example.net', priority: 1 }]);
  const ctx = { websiteDomain: 'shop.cy', freeDomains: new Set(['gmail.com']), mx };

  it('classifies, rejects junk, keeps crawl order and marks one primary', async () => {
    const result = await evaluateSiteEmails(
      [
        { url: 'https://shop.cy/', html: '<p>info@shop.cy logo@2x.png</p>' },
        {
          url: 'https://shop.cy/contact',
          html: '<p>maria@shop.cy, info@shop.cy, owner@gmail.com</p>',
        },
      ],
      ctx,
    );
    expect(
      result.emails.map((e) => [
        e.normalized,
        e.emailType,
        e.isOwnDomain,
        e.isFreeMail,
        e.isPrimary,
      ]),
    ).toEqual([
      ['info@shop.cy', 'GENERIC', true, false, false],
      ['maria@shop.cy', 'PERSONAL', true, false, true],
      ['owner@gmail.com', 'PERSONAL', false, true, false],
    ]);
    expect(result.emails[0]?.sourceUrl).toBe('https://shop.cy/');
    expect(result.rejected).toEqual([{ email: 'logo@2x.png', reason: 'FILE_NAME' }]);
  });

  it('keeps at most MAX_EMAILS_PER_SITE addresses', async () => {
    const many = Array.from(
      { length: MAX_EMAILS_PER_SITE + 3 },
      (_, i) => `person${i}@shop.cy`,
    ).join(' ');
    const result = await evaluateSiteEmails(
      [{ url: 'https://shop.cy/', html: `<p>${many}</p>` }],
      ctx,
    );
    expect(result.emails).toHaveLength(MAX_EMAILS_PER_SITE);
    expect(result.overLimit).toBe(3);
  });

  it('returns nothing for a page without addresses', async () => {
    const result = await evaluateSiteEmails(
      [{ url: 'https://shop.cy/', html: '<p>Call us</p>' }],
      ctx,
    );
    expect(result.emails).toEqual([]);
  });
});

describe('re-crawl schedule', () => {
  const crawl = (outcome: SiteCrawlResult['outcome'], retryable = false): SiteCrawlResult => ({
    outcome,
    pages: [],
    requests: 1,
    finalOrigin: null,
    robotsStatus: null,
    looksJavaScriptRendered: false,
    error: outcome === 'FAILED' ? { code: 'X', message: 'x', retryable } : null,
    pageErrors: [],
  });

  it('never re-crawls a site with emails; retries others later', () => {
    expect(nextRetryDays(crawl('DONE'), 2, 90)).toBeNull();
    expect(nextRetryDays(crawl('DONE'), 0, 90)).toBe(90);
    expect(nextRetryDays(crawl('FAILED', true), 0, 90)).toBe(1);
    expect(nextRetryDays(crawl('FAILED', false), 0, 90)).toBe(90);
    expect(nextRetryDays(crawl('ROBOTS_BLOCKED'), 0, 90)).toBe(90);
  });
});