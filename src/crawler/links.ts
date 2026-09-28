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

    const haystack = `${fold($(element).text())} ${fold(safeDecode(target.pathname))}`;
    const match = PATTERNS.find(([, pattern]) => pattern.test(haystack));
    if (match) found.set(key, { kind: match[0], order: order++ });
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