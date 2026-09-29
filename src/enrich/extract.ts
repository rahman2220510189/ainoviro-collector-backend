import * as cheerio from 'cheerio';
import { extractEmails, normalizeEmail } from '../lib/email';

/**
 * How an email was found on a page (stored in emails.source).
 * "attribute" and "script" come from page code rather than visible text, so the
 * evaluator only trusts them for the site's own domain or free-mail addresses.
 */
export type EmailSource =
  'mailto' | 'cfemail' | 'jsonld' | 'text' | 'obfuscated' | 'attribute' | 'script';

export interface FoundEmail {
  /** As written on the page (original casing), for emails.email. */
  original: string;
  normalized: string;
  source: EmailSource;
  /** Page where it was found. */
  sourceUrl: string;
}

/** Decodes Cloudflare "email protection": hex string, first byte is the XOR key. */
export function decodeCloudflareEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  const bytes: number[] = [];
  for (let i = 2; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16) ^ key);
  // Cloudflare encodes UTF-8 bytes.
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Undoes the encodings that hide "@" and "." in page code and text:
 * "\u0040", "\x40", "%40", "&#64;", "&#x40;", "&commat;", full-width "＠" and "．".
 */
export function decodeEscapes(text: string): string {
  return text
    .replace(/\\u0040|\\x40|%40|&#0*64;|&#x0*40;|&commat;|＠/gi, '@')
    .replace(/\\u002e|\\x2e|&#0*46;|&#x0*2e;|&period;|．/gi, '.');
}

/**
 * Turns common human obfuscations back into an address:
 * "info [at] shop [dot] cy", "info(at)shop(dot)cy", "info {at} shop . cy", "info AT shop DOT cy",
 * and "info at shop dot cy" (lowercase only when a "dot" follows, so ordinary sentences
 * such as "meet us at the shop" are left alone).
 */
export function deobfuscate(text: string): string {
  return text
    .replace(/\s*[[({<]\s*(?:at|@|arroba)\s*[\])}>]\s*/gi, '@')
    .replace(/\s*[[({<]\s*(?:dot|\.|punto)\s*[\])}>]\s*/gi, '.')
    .replace(/\s+AT\s+/g, '@')
    .replace(/\s+DOT\s+/g, '.')
    .replace(
      /\b([a-z0-9._-]+)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)\b/gi,
      (_, local: string, rest: string) => `${local}@${rest.replace(/\s+dot\s+/gi, '.')}`,
    );
}

/** "'info' + '@' + 'shop.cy'" -> "info@shop.cy": joins string pieces glued together in scripts. */
export function joinScriptStrings(code: string): string {
  return code.replace(/["']\s*\+\s*["']/g, '');
}

/** Every string value stored under an "email" key, at any depth of a JSON-LD block. */
function jsonLdEmails(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) jsonLdEmails(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key.toLowerCase() === 'email' && typeof inner === 'string') out.push(inner);
      else jsonLdEmails(inner, out);
    }
  }
}

/** Attributes that hold file names/URLs or styling, never a contact address. */
const SKIPPED_ATTRIBUTES = new Set([
  'src',
  'srcset',
  'style',
  'class',
  'id',
  'd',
  'data-src',
  'data-srcset',
]);

/**
 * Finds all email addresses on one HTML page. Sources, most reliable first:
 * mailto: links, Cloudflare-protected addresses, JSON-LD "email" fields, visible
 * text (HTML entities decoded), obfuscated text, other attributes (data-email,
 * content, value ...) and finally inline scripts (site builders such as Wix keep
 * contact details in script data). Each address appears once, with its best source.
 */
export function extractEmailsFromPage(html: string, pageUrl: string): FoundEmail[] {
  const $ = cheerio.load(html);
  const found = new Map<string, FoundEmail>();
  const add = (raw: string, source: EmailSource): void => {
    const normalized = normalizeEmail(raw);
    if (normalized && !found.has(normalized)) {
      const original =
        raw
          .trim()
          .replace(/^mailto:/i, '')
          .split('?')[0] ?? raw;
      found.set(normalized, { original, normalized, source, sourceUrl: pageUrl });
    }
  };
  const addAll = (text: string, source: EmailSource): void => {
    for (const email of extractEmails(text)) add(email, source);
  };

  // 1. mailto: links (one link can hold several addresses: "mailto:a@x.cy,b@x.cy").
  $('a[href]').each((_, el) => {
    let href = ($(el).attr('href') ?? '').trim();
    try {
      href = decodeURIComponent(href);
    } catch {
      // Keep the raw value.
    }
    if (!/^mailto:/i.test(href)) return;
    const target = href.replace(/^mailto:/i, '').split('?')[0] ?? '';
    for (const part of target.split(/[,;]/)) add(decodeEscapes(part), 'mailto');
  });

  // 2. Cloudflare email protection.
  $('[data-cfemail]').each((_, el) => {
    const decoded = decodeCloudflareEmail($(el).attr('data-cfemail') ?? '');
    if (decoded) add(decoded, 'cfemail');
  });
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const decoded = decodeCloudflareEmail(($(el).attr('href') ?? '').split('#')[1] ?? '');
    if (decoded) add(decoded, 'cfemail');
  });

  // 3. JSON-LD structured data (LocalBusiness.email etc.).
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const values: string[] = [];
      jsonLdEmails(JSON.parse($(el).text()) as unknown, values);
      for (const value of values) add(value, 'jsonld');
    } catch {
      // Broken JSON-LD is common; ignore it.
    }
  });

  // Keep script code aside for step 7, before removing it from the document.
  const scripts = $('script:not([type="application/ld+json"])')
    .map((_, el) => $(el).text())
    .get()
    .join('\n');

  // 6 (collected now, added after text). Attribute values such as data-email, content, value.
  const attributeText: string[] = [];
  $('*').each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    for (const [name, value] of Object.entries(attribs)) {
      const mayHoldEmail = value.includes('@') || /%40|&#|\\u00|\\x40/i.test(value);
      if (name === 'href' || SKIPPED_ATTRIBUTES.has(name) || !mayHoldEmail) continue;
      attributeText.push(value);
    }
  });

  // 4. Visible text, then 5. its de-obfuscated form.
  $('script, style, noscript, template, svg').remove();
  // Keep words apart when tags are removed ("<p>a</p><p>b</p>" -> "a b").
  $('br, p, div, li, td, th, span, a, h1, h2, h3, h4, h5, h6').append(' ');
  const text = decodeEscapes($('body').text() || $.root().text());
  addAll(text, 'text');
  addAll(deobfuscate(text), 'obfuscated');

  addAll(decodeEscapes(attributeText.join(' ')), 'attribute');

  // 7. Inline scripts (joined string pieces, escapes decoded).
  addAll(decodeEscapes(joinScriptStrings(scripts)), 'script');

  return [...found.values()];
}