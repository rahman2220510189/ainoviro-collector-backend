import { platformKindOfHost, type PlatformKind } from './platforms';

/** Query parameters that only track the visitor; removing them never changes the page. */
const TRACKING_PARAM_PREFIXES = ['utm_', 'mc_', 'hsa_', '_hs', 'pk_', 'mtm_', 'matomo_'];
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid',
  'li_fat_id', 'igsh', 'igshid', '_ga', '_gl', '_ke', 'mkt_tok', 'srsltid', 'rdt_cid', 'epik',
  'sscid', 'ref_src', 's_cid', 'trk', 'spm', 'vero_id', 'oly_anon_id', 'oly_enc_id', 'wickedid',
]);

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  return TRACKING_PARAMS.has(key) || TRACKING_PARAM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Cleans a website URL as returned by a data source:
 * trims, adds a missing scheme, allows only http/https, lowercases the host,
 * drops credentials, the "#fragment" and tracking parameters (utm_*, fbclid, igsh ...),
 * and stray trailing punctuation ("taplink.cc/shop." -> "taplink.cc/shop").
 * Returns null when the value is not a usable web address.
 */
export function cleanWebsiteUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim().replace(/[.,;:!)\]}'"]+$/, '');
  if (value === '' || /\s/.test(value)) return null;
  if (value.startsWith('//')) value = `https:${value}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `http://${value}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('.') || host.includes('..')) return null;
  url.hostname = host;
  url.username = '';
  url.password = '';
  url.hash = '';

  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) url.searchParams.delete(name);
  }
  if ([...url.searchParams.keys()].length === 0) url.search = '';
  return url.toString();
}

export interface WebsiteInfo {
  /** Cleaned URL, or null when missing/invalid. */
  website: string | null;
  /** Own domain without "www." (e.g. "shop.cy"); null for platform links and invalid values. */
  domain: string | null;
  /** Set when the link is a social/booking/listing page instead of an own website. */
  platform: PlatformKind | null;
}

/** Cleans a website and decides whether it is the business's OWN site. */
export function analyzeWebsite(raw: string | null | undefined): WebsiteInfo {
  const website = cleanWebsiteUrl(raw);
  if (!website) return { website: null, domain: null, platform: null };
  const host = new URL(website).hostname;
  const platform = platformKindOfHost(host);
  return {
    website,
    domain: platform ? null : host.replace(/^www\./, ''),
    platform,
  };
}