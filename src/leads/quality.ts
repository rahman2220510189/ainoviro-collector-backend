import type { LeadRules } from './rules';

/** What the quality gate and the lead score look at for one place. */
export interface LeadFacts {
  cityName: string | null;
  countryCode: string;
  phoneValid: boolean;
  websiteDomain: string | null;
  rating: number | null;
  ratingCount: number | null;
  businessStatus: string;
  isChain: boolean;
  hasCategory: boolean;
  /** The place's primary email, or null when no email was found. */
  primary: {
    syntaxValid: boolean;
    mxValid: boolean | null;
    isOwnDomain: boolean;
  } | null;
}

export type ReviewReason =
  | 'EMAIL_SYNTAX'
  | 'EMAIL_NO_MX'
  | 'EMAIL_MX_UNKNOWN'
  | 'NO_REAL_CITY'
  | 'NO_CATEGORY'
  | 'PHONE_INVALID';

/**
 * Country names (lowercase, no accents) that are never a city, whatever the place's
 * country ("Cyprus" as the city of a place means the city is unknown).
 */
const COUNTRY_NAMES = new Set([
  'cyprus',
  'kypros',
  'κυπρος',
  'republic of cyprus',
  'bangladesh',
  'greece',
  'ελλαδα',
]);

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** A city name that is a real place: not empty, not "unknown", not the country itself. */
export function isRealCity(cityName: string | null, countryCode: string): boolean {
  if (!cityName) return false;
  const city = fold(cityName);
  if (city === '' || city === 'unknown' || city === 'n/a' || city === countryCode.toLowerCase())
    return false;
  return !COUNTRY_NAMES.has(city);
}

/**
 * Quality gate (spec §10). Only places WITH a primary email are checked: a place
 * without email is simply not a lead yet, not something to review. Returns the
 * reasons the place fails; empty = passes.
 */
export function reviewReasons(facts: LeadFacts, rules: LeadRules['quality']): ReviewReason[] {
  if (!facts.primary) return [];
  const reasons: ReviewReason[] = [];
  if (rules.emailSyntax && !facts.primary.syntaxValid) reasons.push('EMAIL_SYNTAX');
  if (rules.emailMx && facts.primary.mxValid === false) reasons.push('EMAIL_NO_MX');
  if (rules.emailMx && facts.primary.mxValid === null) reasons.push('EMAIL_MX_UNKNOWN');
  if (rules.realCity && !isRealCity(facts.cityName, facts.countryCode))
    reasons.push('NO_REAL_CITY');
  if (rules.category && !facts.hasCategory) reasons.push('NO_CATEGORY');
  if (rules.validPhone && !facts.phoneValid) reasons.push('PHONE_INVALID');
  return reasons;
}

/** Lead score (spec §10 defaults): higher = better lead; export is sorted by it. */
export function leadScore(facts: LeadFacts, rules: LeadRules['score']): number {
  let score = 0;
  if (facts.primary?.isOwnDomain) score += rules.ownDomainEmail;
  if (facts.websiteDomain) score += rules.hasWebsite;
  if (facts.phoneValid) score += rules.validPhone;
  if (
    facts.rating !== null &&
    facts.rating >= rules.goodRatingMin &&
    (facts.ratingCount ?? 0) >= rules.goodRatingMinCount
  )
    score += rules.goodRating;
  if (facts.businessStatus === 'OPERATIONAL') score += rules.open;
  if (facts.isChain) score += rules.chain;
  return score;
}

/** What chain detection needs to know about a place. */
export interface ChainPlace {
  id: number;
  nameNormalized: string;
  websiteDomain: string | null;
}

export interface ChainEntry {
  nameNormalized: string;
  domain: string | null;
}

export type ChainReason = 'BLOCKLIST' | 'SHARED_DOMAIN';

/**
 * Chains (spec §10): the name or domain is on chain_blocklist, or the same own website
 * domain is used by minPlacesPerDomain or more places. A blocklist name matches the
 * whole name or its first words ("zara" matches "zara home limassol").
 */
export function detectChains(
  places: ChainPlace[],
  blocklist: ChainEntry[],
  rules: LeadRules['chains'],
): Map<number, ChainReason> {
  const domainCount = new Map<string, number>();
  for (const p of places)
    if (p.websiteDomain)
      domainCount.set(p.websiteDomain, (domainCount.get(p.websiteDomain) ?? 0) + 1);
  const blockedDomains = new Set(
    blocklist.map((b) => b.domain?.toLowerCase().replace(/^www\./, '')).filter(Boolean),
  );
  const blockedNames = blocklist.map((b) => b.nameNormalized).filter((n) => n !== '');

  const chains = new Map<number, ChainReason>();
  for (const p of places) {
    const byName = blockedNames.some(
      (n) => p.nameNormalized === n || p.nameNormalized.startsWith(`${n} `),
    );
    if (byName || (p.websiteDomain && blockedDomains.has(p.websiteDomain)))
      chains.set(p.id, 'BLOCKLIST');
    else if (p.websiteDomain && (domainCount.get(p.websiteDomain) ?? 0) >= rules.minPlacesPerDomain)
      chains.set(p.id, 'SHARED_DOMAIN');
  }
  return chains;
}

/** Candidate for a place's primary subcategory. */
export interface SubcategoryCandidate {
  subcategoryId: number;
  /** Search keywords of this subcategory (any language). */
  keywords: string[];
}

/** Words too common to tell subcategories apart. */
const WEAK_WORDS = new Set(
  'salon studio shop store center centre services service and the for bar house lounge'.split(' '),
);

const stem = (w: string): string => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);

/**
 * Primary subcategory of a place found under several: the one whose keywords appear in
 * the business name ("MO Nails" -> nail salon), otherwise the first one it was found
 * under (candidates in the order found). Returns null when there is no candidate.
 */
export function pickPrimarySubcategory(
  nameNormalized: string,
  candidates: SubcategoryCandidate[],
): number | null {
  const nameWords = new Set(
    fold(nameNormalized)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3)
      .map(stem),
  );
  let best: { id: number; hits: number } | null = null;
  for (const c of candidates) {
    const words = new Set(
      c.keywords
        .flatMap((k) => fold(k).split(/[^\p{L}\p{N}]+/u))
        .filter((w) => w.length >= 3 && !WEAK_WORDS.has(w))
        .map(stem),
    );
    let hits = 0;
    for (const w of words) if (nameWords.has(w)) hits += 1;
    if (!best || hits > best.hits) best = { id: c.subcategoryId, hits };
  }
  return best?.id ?? null;
}