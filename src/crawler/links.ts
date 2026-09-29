import * as cheerio from 'cheerio';

export type PageKind = 'HOME' | 'CONTACT' | 'ABOUT' | 'LEGAL' | 'PRIVACY';

export interface ContactLink {
  url: string;
  kind: Exclude<PageKind, 'HOME'>;
}

/**
 * Words that mark pages likely to show an email, in priority order. Matched
 * against the link text and the URL path, after lowercasing and removing
 * accents, so "Επικοινωνία", "ΕΠΙΚΟΙΝΩΝΙΑ" and "/epikoinonia" all match.
 */
const PATTERNS: [ContactLink['kind'], RegExp][] = [
  ['CONTACT', /contact|kontakt|epikoinon|επικοινων|get-?in-?touch|reach-?us|find-?us|βρειτε μας/],
  [
    'ABOUT',
    /about|who-?we-?are|our-?story|σχετικ|ποιοι ειμαστε|ποιοι-ειμαστε|ταυτοτητα|η εταιρεια/,
  ],
  ['LEGAL', /impressum|imprint|legal|terms|conditions|οροι|νομικ/],
  ['PRIVACY', /privacy|gdpr|απορρητ|προσωπικα δεδομενα|προστασια δεδομενων/],
];

const PRIORITY: Record<ContactLink['kind'], number> = {
  CONTACT: 0,
  ABOUT: 1,
  LEGAL: 2,
  PRIVACY: 3,
};

/** Links to files are never fetched as pages. */
const FILE_EXTENSION =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|docx?|xlsx?|pptx?|mp[34]|mov|avi|css|js|xml|json)$/i;

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** "www.shop.cy" and "shop.cy" are the same site. */
export function sameSite(hostA: string, hostB: string): boolean {
  const strip = (h: string): string => h.toLowerCase().replace(/^www\./, '');
  return strip(hostA) === strip(hostB);
}

/** Which kind of page a link points to, judged from its text and path; null = not useful. */
export function classifyLink(url: URL, text: string): ContactLink['kind'] | null {
  const haystack = `${fold(text)} ${fold(safeDecode(url.pathname))}`;
  return PATTERNS.find(([, pattern]) => pattern.test(haystack))?.[0] ?? null;
}

/** Sorts links: contact pages first, then about, legal, privacy; stable within a kind. */
export function sortLinks(links: ContactLink[]): ContactLink[] {
  return links
    .map((link, order) => ({ link, order }))
    .sort((a, b) => PRIORITY[a.link.kind] - PRIORITY[b.link.kind] || a.order - b.order)
    .map(({ link }) => link);
}

/** <loc> entries of a sitemap (or sitemap index) XML document. */
export function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    (m[1] ?? '').replace(/&amp;/g, '&'),
  );
}

/**
 * Useful same-site pages listed in a sitemap (used when the homepage menu is
 * built by JavaScript and shows no links).
 */
export function contactLinksFromSitemap(xml: string, siteUrl: string): ContactLink[] {
  const base = new URL(siteUrl);
  const links: ContactLink[] = [];
  for (const loc of sitemapLocations(xml)) {
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      continue;
    }
    if (!sameSite(url.hostname, base.hostname) || FILE_EXTENSION.test(url.pathname)) continue;
    const kind = classifyLink(url, '');
    if (kind) links.push({ url: url.toString(), kind });
  }
  return sortLinks(links);
}

/** Common contact page addresses, tried only when nothing else points to a contact page. */
export const GUESSED_CONTACT_PATHS = ['contact', 'contact-us', 'epikoinonia'];

/**
 * Base for guessed paths. Sites hosted in a folder ("user.wixsite.com/mysite")
 * keep their pages under that folder.
 */
export function siteBase(homeUrl: string): string {
  const url = new URL(homeUrl);
  const firstFolder = url.pathname.split('/').filter((p) => p !== '')[0];
  if (url.hostname.endsWith('.wixsite.com') && firstFolder) return `${url.origin}/${firstFolder}/`;
  return `${url.origin}/`;
}

/**
 * Finds same-site links to contact/about/legal/privacy pages, best first,
 * without duplicates. External sites, files, mailto:, tel: and the page itself
 * are ignored.
 */
export function findContactLinks(html: string, pageUrl: string): ContactLink[] {
  const base = new URL(pageUrl);
  const $ = cheerio.load(html);
  const found = new Map<string, { kind: ContactLink['kind']; order: number }>();
  let order = 0;

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')?.trim();
    if (!href || href.startsWith('#')) return;
    let target: URL;
    try {
      target = new URL(href, base);
    } catch {
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
    if (!sameSite(target.hostname, base.hostname)) return;
    if (FILE_EXTENSION.test(target.pathname)) return;
    target.hash = '';
    const key = target.toString();
    if (key === base.toString() || found.has(key)) return;

    const kind = classifyLink(target, $(element).text());
    if (kind) found.set(key, { kind, order: order++ });
  });

  return [...found.entries()]
    .sort((a, b) => PRIORITY[a[1].kind] - PRIORITY[b[1].kind] || a[1].order - b[1].order)
    .map(([url, { kind }]) => ({ url, kind }));
}

/**
 * Rough sign that a page is built by JavaScript in the browser (little visible
 * text but an app container or framework data). Used later to decide on the
 * optional Playwright fallback; nothing depends on it yet.
 */
export function looksJavaScriptRendered(html: string): boolean {
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  const visibleText = $('body').text().replace(/\s+/g, ' ').trim();
  const appShell =
    /id=["'](root|app|__next|__nuxt)["']|__NEXT_DATA__|ng-version|data-reactroot/i.test(html);
  return visibleText.length < 200 && appShell;
}