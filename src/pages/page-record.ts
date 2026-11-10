import { normalizePhone } from '../cleaning/phone';
import { platformDomainOfHost } from '../cleaning/platforms';
import { analyzeWebsite } from '../cleaning/website';
import type { PageArea, PageType } from './page-types';

/**
 * One business, ready for a claimable ainoviro page (step 7.6, Marketplace Plan).
 *
 * Built ONLY from open data (Overture Maps, Foursquare OS Places) and the business's own
 * website. From Google we keep just the place ID and a Maps link, which Google's terms
 * allow; no Google name, phone, address, rating, reviews or photos. Every field records
 * where it came from (`sources`), as the plan requires.
 */
export type FieldSource = 'overture' | 'foursquare' | 'website' | 'collector';

export interface SourceRef {
  source: FieldSource;
  /** The source's own record id (Overture GERS id, Foursquare id, website domain). */
  recordId: string;
  /** When we fetched it (ISO). */
  fetchedAt: string | null;
}

export interface PageRecord {
  /** Stable id of the business in the Lead Collector (use it for upserts). */
  collectorId: number;
  name: string;
  type: { key: string; label: string };
  /** The Overture category the type was taken from (e.g. "hair_salon"). */
  overtureCategory: string;
  area: { key: string; label: string };
  city: string | null;
  address: string | null;
  postcode: string | null;
  lat: number;
  lng: number;
  /** E.164, only when valid. */
  phone: string | null;
  /** The business's own website (not a social or booking platform). */
  website: string | null;
  socials: Record<string, string>;
  /** Host of a booking platform the business already uses (e.g. "fresha.com"), if any. */
  bookingPlatform: string | null;
  /** Public business email found in open data or on its own website. */
  email: string | null;
  /** The business's website already sells online (from our shop check). */
  sellsOnline: boolean | null;
  /** Opening hours are not available from these sources yet. */
  hours: null;
  google: { placeId: string; mapsUrl: string } | null;
  page: {
    status: 'UNPUBLISHED' | 'PUBLISHED' | 'CLAIMED';
    url: string | null;
    claimedAt: string | null;
  };
  /** How complete the page would be (0–100) and what is missing; thin pages stay noindex. */
  completeness: { score: number; missing: string[] };
  sources: Record<string, SourceRef>;
  /** Credit lines the page must show for the open data it uses. */
  attribution: string[];
}

export interface OvertureRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  taxonomy_primary: string | null;
  websites: string[];
  phones: string[];
  emails: string[];
  socials: string[];
  address: string | null;
  locality: string | null;
  postcode: string | null;
  imported_at: Date | string;
}

export interface FoursquareRow {
  id: string;
  website: string | null;
  tel: string | null;
  email: string | null;
  facebook_id: string | null;
  instagram: string | null;
  imported_at: Date | string;
}

export interface PlaceFacts {
  id: number;
  countryCode: string;
  cityName: string | null;
  googlePlaceId: string | null;
  /** The place's primary email and where it was found ("overture", "mailto", …). */
  primaryEmail: { email: string; source: string; foundAt: Date | string | null } | null;
  sellsOnline: boolean | null;
  page: {
    status: 'PUBLISHED' | 'CLAIMED';
    url: string | null;
    claimedAt: Date | string | null;
  } | null;
}

/** Overture's credit line (verify the exact wording required by each release's licence). */
export const OVERTURE_ATTRIBUTION = 'Overture Maps Foundation';
export const FOURSQUARE_ATTRIBUTION = 'Foursquare Open Source Places';

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/** Google's documented way to open a place by its ID in Maps. */
export function googleMapsUrl(placeId: string, name: string): string {
  const q = encodeURIComponent(name);
  return `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${encodeURIComponent(placeId)}`;
}

const SOCIAL_KEYS: [string, RegExp][] = [
  ['instagram', /(^|\.)instagram\.com$|(^|\.)instagr\.am$/],
  ['facebook', /(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fb\.me$/],
  ['tiktok', /(^|\.)tiktok\.com$/],
  ['linkedin', /(^|\.)linkedin\.com$/],
  ['youtube', /(^|\.)youtube\.com$|(^|\.)youtu\.be$/],
];

function socialKey(host: string): string | null {
  const h = host.replace(/^www\./, '');
  return SOCIAL_KEYS.find(([, re]) => re.test(h))?.[0] ?? null;
}

/**
 * Builds a page record from the open-data rows of one place. Returns null when the place
 * cannot get a page from open data alone (no Overture row, or no usable name).
 */
export function buildPageRecord(input: {
  place: PlaceFacts;
  overture: OvertureRow | null;
  foursquare: FoursquareRow | null;
  type: PageType;
  area: PageArea;
}): PageRecord | null {
  const { place, overture: ovt, foursquare: fsq, type, area } = input;
  if (!ovt || !ovt.name.trim()) return null;

  const sources: Record<string, SourceRef> = {};
  const fromOvt: SourceRef = {
    source: 'overture',
    recordId: ovt.id,
    fetchedAt: iso(ovt.imported_at),
  };
  const fromFsq: SourceRef | null = fsq
    ? { source: 'foursquare', recordId: fsq.id, fetchedAt: iso(fsq.imported_at) }
    : null;
  let usedFsq = false;

  sources.name = fromOvt;
  sources.location = fromOvt;
  sources.category = fromOvt;
  const address = ovt.address?.trim() || null;
  if (address) sources.address = fromOvt;
  const postcode = ovt.postcode?.trim() || null;
  if (postcode) sources.postcode = fromOvt;
  const city = ovt.locality?.trim() || place.cityName || null;
  if (city)
    sources.city = ovt.locality?.trim()
      ? fromOvt
      : { source: 'collector', recordId: String(place.id), fetchedAt: null };

  // Phone: Overture first, then Foursquare; only valid numbers.
  let phone: string | null = null;
  for (const raw of ovt.phones) {
    const p = normalizePhone(raw, place.countryCode);
    if (p.valid) {
      phone = p.e164;
      sources.phone = fromOvt;
      break;
    }
  }
  if (!phone && fsq?.tel && fromFsq) {
    const p = normalizePhone(fsq.tel, place.countryCode);
    if (p.valid) {
      phone = p.e164;
      sources.phone = fromFsq;
      usedFsq = true;
    }
  }

  // Links: own website vs social and booking platforms.
  let website: string | null = null;
  let bookingPlatform: string | null = null;
  const socials: Record<string, string> = {};
  const links: [string, SourceRef][] = ovt.websites.map((w) => [w, fromOvt]);
  for (const s of ovt.socials) links.push([s, fromOvt]);
  if (fsq && fromFsq) {
    if (fsq.website) links.push([fsq.website, fromFsq]);
    if (fsq.instagram)
      links.push([`https://instagram.com/${fsq.instagram.replace(/^@/, '')}`, fromFsq]);
    if (fsq.facebook_id) links.push([`https://www.facebook.com/${fsq.facebook_id}`, fromFsq]);
  }
  for (const [raw, src] of links) {
    const info = analyzeWebsite(raw);
    if (!info.website) continue;
    const host = new URL(info.website).hostname;
    if (!info.platform) {
      if (!website) {
        website = info.website;
        sources.website = src;
        if (src === fromFsq) usedFsq = true;
      }
    } else if (info.platform === 'SOCIAL') {
      const key = socialKey(host);
      if (key && !socials[key]) {
        socials[key] = info.website;
        sources[`socials.${key}`] = src;
        if (src === fromFsq) usedFsq = true;
      }
    } else if (info.platform === 'BOOKING' && !bookingPlatform) {
      bookingPlatform = platformDomainOfHost(host) ?? host.replace(/^www\./, '');
      sources.bookingPlatform = src;
      if (src === fromFsq) usedFsq = true;
    }
  }

  // Email: the place's primary email (Google never supplies emails), or open data.
  let email: string | null = null;
  if (place.primaryEmail) {
    email = place.primaryEmail.email;
    const src = place.primaryEmail.source.toLowerCase();
    sources.email =
      src === 'overture'
        ? fromOvt
        : src === 'foursquare' && fromFsq
          ? fromFsq
          : {
              source: 'website',
              recordId: website
                ? new URL(website).hostname.replace(/^www\./, '')
                : String(place.id),
              fetchedAt: iso(place.primaryEmail.foundAt),
            };
    if (sources.email === fromFsq) usedFsq = true;
  } else if (ovt.emails[0]) {
    email = ovt.emails[0].trim().toLowerCase();
    sources.email = fromOvt;
  }

  if (place.sellsOnline !== null && website) {
    sources.sellsOnline = {
      source: 'website',
      recordId: new URL(website).hostname.replace(/^www\./, ''),
      fetchedAt: null,
    };
  }

  const google = place.googlePlaceId
    ? { placeId: place.googlePlaceId, mapsUrl: googleMapsUrl(place.googlePlaceId, ovt.name.trim()) }
    : null;

  // Completeness: what the page has now (photos, services and prices come from the owner).
  const checks: [string, boolean][] = [
    ['phone', phone !== null],
    ['address', address !== null],
    ['website or social link', website !== null || Object.keys(socials).length > 0],
    ['email', email !== null],
    ['opening hours', false],
    ['photos', false],
    ['services and prices', false],
  ];
  const score = Math.round(
    (100 * (2 + checks.filter(([, ok]) => ok).length)) / (2 + checks.length), // name + category always present
  );

  return {
    collectorId: place.id,
    name: ovt.name.trim(),
    type: { key: type.key, label: type.label },
    overtureCategory: ovt.taxonomy_primary ?? '',
    area: { key: area.key, label: area.label },
    city,
    address,
    postcode,
    lat: ovt.lat,
    lng: ovt.lng,
    phone,
    website,
    socials,
    bookingPlatform,
    email,
    sellsOnline: website ? place.sellsOnline : null,
    hours: null,
    google,
    page: place.page
      ? { status: place.page.status, url: place.page.url, claimedAt: iso(place.page.claimedAt) }
      : { status: 'UNPUBLISHED', url: null, claimedAt: null },
    completeness: { score, missing: checks.filter(([, ok]) => !ok).map(([k]) => k) },
    sources,
    attribution: usedFsq ? [OVERTURE_ATTRIBUTION, FOURSQUARE_ATTRIBUTION] : [OVERTURE_ATTRIBUTION],
  };
}

/** Flat CSV columns of a page record (JSON keeps everything, including `sources`). */
export const PAGE_CSV_HEADER = [
  'collector_id',
  'name',
  'type',
  'type_label',
  'overture_category',
  'area',
  'city',
  'address',
  'postcode',
  'lat',
  'lng',
  'phone',
  'website',
  'instagram',
  'facebook',
  'other_socials',
  'booking_platform',
  'email',
  'sells_online',
  'google_place_id',
  'google_maps_url',
  'page_status',
  'page_url',
  'completeness',
  'missing',
  'attribution',
  'sources',
];

export function pageCsvRow(r: PageRecord): (string | number | null)[] {
  const { instagram, facebook, ...other } = r.socials;
  return [
    r.collectorId,
    r.name,
    r.type.key,
    r.type.label,
    r.overtureCategory,
    r.area.key,
    r.city,
    r.address,
    r.postcode,
    r.lat,
    r.lng,
    r.phone,
    r.website,
    instagram ?? null,
    facebook ?? null,
    Object.values(other).join(' ') || null,
    r.bookingPlatform,
    r.email,
    r.sellsOnline === null ? null : r.sellsOnline ? 'yes' : 'no',
    r.google?.placeId ?? null,
    r.google?.mapsUrl ?? null,
    r.page.status,
    r.page.url,
    r.completeness.score,
    r.completeness.missing.join('; '),
    r.attribution.join('; '),
    Object.entries(r.sources)
      .map(([k, s]) => `${k}=${s.source}`)
      .join('; '),
  ];
}
