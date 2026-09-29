import { platformKindOfHost } from '../cleaning/platforms';

const words = (text: string): string[] => text.trim().split(/\s+/);

/** "logo@2x.png": image/file names that look like addresses. */
const FILE_TLDS = new Set(
  words(
    'png jpg jpeg gif webp svg bmp ico tif tiff avif css js mjs map json xml pdf mp4 mp3 webm ' +
      'woff woff2 ttf',
  ),
);

/** Placeholder domains used in templates and forms ("name@example.com"). */
const PLACEHOLDER_DOMAIN =
  /(^|\.)(example|domain|yourdomain|yoursite|yourcompany|mydomain|mysite|website|test|sample|company)\.[a-z.]+$/;

/** Monitoring, CDN and platform infrastructure: never a business contact. */
const TECH_DOMAINS = words(
  'sentry.io sentry-next.wixpress.com sentry.wixpress.com wixpress.com wix.com cloudflare.com ' +
    'w3.org schema.org godaddy.com squarespace.com shopify.com wordpress.com wordpress.org ' +
    'mailchimp.com hubspot.com sendgrid.net amazonaws.com googleusercontent.com ' +
    'doubleclick.net jquery.com',
);

/** Local parts that are never a real contact. */
const JUNK_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|abuse|bounces?|test|user|username|your-?name|yourname|your|your-?email|youremail|name|you|someone|john\.?doe|jane\.?doe|firstname\.?lastname)$/;

/** Domains of disposable (throw-away) mailbox services. */
export const DISPOSABLE_DOMAINS = new Set(
  words(
    'mailinator.com guerrillamail.com guerrillamail.net sharklasers.com 10minutemail.com ' +
      'tempmail.com temp-mail.org yopmail.com trashmail.com getnada.com dispostable.com ' +
      'maildrop.cc throwawaymail.com fakeinbox.com mintemail.com mohmal.com emailondeck.com ' +
      'tempail.com burnermail.io mailnesia.com',
  ),
);

export type RejectReason =
  | 'FILE_NAME'
  | 'PLACEHOLDER'
  | 'TECH_DOMAIN'
  | 'PLATFORM_DOMAIN'
  | 'JUNK_LOCAL'
  | 'HASH_LOCAL'
  /** Found only in page code (script/attribute) and not on the site's own or a free-mail domain. */
  | 'THIRD_PARTY_IN_CODE';

function domainMatches(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Why a found address is not a business contact, or null when it looks real.
 * Input must be a normalized email.
 */
export function rejectReason(email: string): RejectReason | null {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const tld = domain.slice(domain.lastIndexOf('.') + 1);

  if (FILE_TLDS.has(tld)) return 'FILE_NAME';
  if (PLACEHOLDER_DOMAIN.test(domain)) return 'PLACEHOLDER';
  if (domainMatches(domain, TECH_DOMAINS)) return 'TECH_DOMAIN';
  // e.g. "info@instagram.com" copied from a footer; the business does not own it.
  if (platformKindOfHost(domain)) return 'PLATFORM_DOMAIN';
  if (JUNK_LOCAL.test(local)) return 'JUNK_LOCAL';
  // Long hex/random strings are keys (Sentry DSNs etc.), not mailboxes.
  if (/^[0-9a-f]{16,}$/.test(local)) return 'HASH_LOCAL';
  return null;
}

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain);
}