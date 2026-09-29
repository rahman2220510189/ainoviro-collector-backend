import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { crawlSite } from '../src/crawler/crawl-site';
import { contactLinksFromSitemap, siteBase, sitemapLocations } from '../src/crawler/links';
import { crawlerSettingsSchema } from '../src/crawler/settings';
import {
  createTestWebsite,
  type TestWebsite,
  type TestWebsiteOptions,
} from '../src/dev/test-website';
import { evaluateSiteEmails } from '../src/enrich/evaluate';
import {
  decodeEscapes,
  deobfuscate,
  extractEmailsFromPage,
  joinScriptStrings,
} from '../src/enrich/extract';
import { MxChecker } from '../src/enrich/mx';

const PAGE = 'https://shop.cy/contact';
const emailsOf = (html: string) =>
  extractEmailsFromPage(html, PAGE).map((e) => [e.normalized, e.source]);

describe('hidden and encoded addresses', () => {
  it('decodes escaped "@" and "." forms', () => {
    expect(decodeEscapes('info\\u0040shop\\u002ecy')).toBe('info@shop.cy');
    expect(decodeEscapes('info\\x40shop.cy')).toBe('info@shop.cy');
    expect(decodeEscapes('info%40shop.cy')).toBe('info@shop.cy');
    expect(decodeEscapes('info&#64;shop&#46;cy')).toBe('info@shop.cy');
    expect(decodeEscapes('info＠shop.cy')).toBe('info@shop.cy');
  });

  it('understands "name at domain dot tld" only when a "dot" follows', () => {
    expect(deobfuscate('write to maria at shop dot com dot cy')).toBe('write to maria@shop.com.cy');
    expect(deobfuscate('we are open at weekends')).toBe('we are open at weekends');
  });

  it('joins string pieces glued together in scripts', () => {
    expect(joinScriptStrings(`var e = 'info' + '@' + 'shop.cy';`)).toBe(`var e = 'info@shop.cy';`);
  });

  it('finds addresses in data attributes, encoded mailto links and script data', () => {
    const html = `
      <a href=" MAILTO:%69nfo@shop.cy ">write</a>
      <span data-email="booking&#64;shop.cy">Book</span>
      <script>window.site = {"contact":"owner\\u0040shop.cy"}; var x = 'sales' + '@' + 'shop.cy';</script>`;
    expect(emailsOf(html)).toEqual([
      ['info@shop.cy', 'mailto'],
      ['booking@shop.cy', 'attribute'],
      ['owner@shop.cy', 'script'],
      ['sales@shop.cy', 'script'],
    ]);
  });

  it('keeps addresses from page code only for the own domain or free mail', async () => {
    const mx = new MxChecker(async () => [{ exchange: 'mx.example.net', priority: 1 }]);
    const html = `<script>var a = "owner@shop.cy", b = "dev@webagency.cy", c = "shop.limassol@gmail.com";</script>`;
    const result = await evaluateSiteEmails([{ url: PAGE, html }], {
      websiteDomain: 'shop.cy',
      freeDomains: new Set(['gmail.com']),
      mx,
    });
    expect(result.emails.map((e) => e.normalized)).toEqual([
      'owner@shop.cy',
      'shop.limassol@gmail.com',
    ]);
    expect(result.rejected).toEqual([{ email: 'dev@webagency.cy', reason: 'THIRD_PARTY_IN_CODE' }]);
  });

  it('still trusts visible text from any domain', async () => {
    const mx = new MxChecker(async () => [{ exchange: 'mx.example.net', priority: 1 }]);
    const result = await evaluateSiteEmails([{ url: PAGE, html: '<p>office@partner.cy</p>' }], {
      websiteDomain: 'shop.cy',
      freeDomains: new Set(),
      mx,
    });
    expect(result.emails.map((e) => e.normalized)).toEqual(['office@partner.cy']);
  });
});

describe('sitemaps and folder sites', () => {
  it('reads <loc> entries and keeps same-site contact-like pages', () => {
    const xml = `<urlset><url><loc>https://shop.cy/</loc></url><url><loc>https://www.shop.cy/el/epikoinonia</loc></url>
      <url><loc>https://shop.cy/about-us?a=1&amp;b=2</loc></url><url><loc>https://other.cy/contact</loc></url></urlset>`;
    expect(sitemapLocations(xml)).toHaveLength(4);
    expect(contactLinksFromSitemap(xml, 'https://shop.cy/')).toEqual([
      { url: 'https://www.shop.cy/el/epikoinonia', kind: 'CONTACT' },
      { url: 'https://shop.cy/about-us?a=1&b=2', kind: 'ABOUT' },
    ]);
  });

  it('keeps the folder of sites hosted like "user.wixsite.com/mysite"', () => {
    expect(siteBase('https://anna.wixsite.com/mysite')).toBe('https://anna.wixsite.com/mysite/');
    expect(siteBase('https://shop.cy/en/home')).toBe('https://shop.cy/');
  });
});

let site: TestWebsite | undefined;
afterEach(async () => {
  await site?.app.close();
  site = undefined;
});

async function crawlDemo(options: TestWebsiteOptions) {
  site = createTestWebsite(options);
  await site.app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(site.app.server.address() as AddressInfo).port}`;
  return crawlSite(`${origin}/`, {
    settings: crawlerSettingsSchema.parse({}),
    sleep: async () => {},
    testOrigins: [origin],
  });
}

describe('finding the contact page when the menu has no links', () => {
  it('uses the sitemap', async () => {
    const result = await crawlDemo({ menu: 'javascript', sitemap: true });
    expect(result.contactSource).toBe('SITEMAP');
    expect(result.pages.map((p) => [new URL(p.url).pathname, p.kind])).toEqual([
      ['/', 'HOME'],
      ['/get-in-touch', 'CONTACT'],
      ['/terms', 'LEGAL'],
    ]);
  });

  it('tries common contact addresses when there is no sitemap, and stops at the first that works', async () => {
    const result = await crawlDemo({ menu: 'javascript', sitemap: false });
    expect(result.contactSource).toBe('GUESSED');
    expect(result.pages.map((p) => new URL(p.url).pathname)).toEqual(['/', '/contact']);
    expect(site?.hits.get('/contact-us')).toBeUndefined();
    // A missing guessed page is not reported as a problem.
    expect(result.pageErrors).toEqual([]);
  });

  it('does not guess when the homepage already links to a contact page', async () => {
    const result = await crawlDemo({ menu: 'links' });
    expect(result.contactSource).toBe('LINKS');
    expect(site?.hits.get('/sitemap.xml')).toBeUndefined();
  });

  it('never guesses a path that robots.txt forbids', async () => {
    const result = await crawlDemo({
      menu: 'javascript',
      robotsTxt: 'User-agent: *\nDisallow: /contact\nDisallow: /sitemap.xml\n',
    });
    expect(site?.hits.get('/contact')).toBeUndefined();
    expect(site?.hits.get('/contact-us')).toBeUndefined();
    expect(site?.hits.get('/sitemap.xml')).toBeUndefined();
    expect(result.contactSource).toBe('NONE');
  });
});

describe('fixes after the first real crawl', () => {
  it('never glues a URL path onto an address', () => {
    const html =
      '<script>var dsn = "https://605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com/1";' +
      ' var img = "//shop.cy/wp-content/images/ajax-loader@2x.gif";</script>';
    expect(emailsOf(html)).toEqual([
      ['605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com', 'script'],
      ['ajax-loader@2x.gif', 'script'],
    ]);
  });

  it('falls back to the homepage when the given page no longer exists', async () => {
    site = createTestWebsite();
    await site.app.listen({ port: 0, host: '127.0.0.1' });
    const origin = `http://127.0.0.1:${(site.app.server.address() as AddressInfo).port}`;
    const result = await crawlSite(`${origin}/en/old-offer`, {
      settings: crawlerSettingsSchema.parse({}),
      sleep: async () => {},
      testOrigins: [origin],
    });
    expect(result.outcome).toBe('DONE');
    expect(result.pages[0]?.url).toBe(`${origin}/`);
  });
});