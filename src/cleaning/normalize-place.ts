import type { CityMatch, CityResolver } from './city';
import { normalizeBusinessName } from './name';
import { normalizePhone } from './phone';
import type { PlatformKind } from './platforms';
import { analyzeWebsite } from './website';

/** Raw values of one place as a source delivered them. */
export interface RawPlaceFields {
  name: string | null;
  website: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
}

export interface NormalizeContext {
  countryCode: string;
  cities: CityResolver | null;
  /** City of the search area, used when coordinates give no answer. */
  fallbackCityId: number | null;
}

/** Cleaned, matching-ready fields. The single place where these rules live. */
export interface NormalizedPlaceFields {
  name: string;
  nameNormalized: string;
  website: string | null;
  websiteDomain: string | null;
  websitePlatform: PlatformKind | null;
  phoneRaw: string | null;
  phoneE164: string | null;
  phoneValid: boolean;
  city: CityMatch | null;
}

export function normalizePlaceFields(
  raw: RawPlaceFields,
  ctx: NormalizeContext,
): NormalizedPlaceFields {
  const name = raw.name?.trim() || 'Unnamed';
  const site = analyzeWebsite(raw.website);
  const phone = normalizePhone(raw.phone, ctx.countryCode);
  return {
    name,
    nameNormalized: normalizeBusinessName(name),
    website: site.website,
    websiteDomain: site.domain,
    websitePlatform: site.platform,
    phoneRaw: phone.raw,
    phoneE164: phone.e164,
    phoneValid: phone.valid,
    city: ctx.cities ? ctx.cities.resolve(raw.lat, raw.lng, ctx.fallbackCityId) : null,
  };
}