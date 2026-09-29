import type { Pool } from 'pg';
import { findDuplicates, type DuplicateGroup, type PossibleDuplicate } from './dedupe';
import { mergePlaceGroup } from './merge';
import {
  detectChains,
  leadScore,
  pickPrimarySubcategory,
  reviewReasons,
  type ChainReason,
  type LeadFacts,
  type ReviewReason,
} from './quality';
import type { LeadRules } from './rules';

const BATCH_SIZE = 1000;

/**
 * Gives every place found under several subcategories exactly one primary
 * subcategory (used as the CSV "category"). Places that already have one keep it.
 */
export async function setPrimarySubcategories(
  db: Pool,
  countryCode: string,
  dryRun: boolean,
): Promise<number> {
  const { rows } = await db.query<{
    place_id: number;
    name_normalized: string;
    subcategory_ids: number[];
  }>(
    `SELECT p.id AS place_id, p.name_normalized,
            array_agg(ps.subcategory_id ORDER BY ps.created_at, ps.subcategory_id) AS subcategory_ids
     FROM places p JOIN place_subcategories ps ON ps.place_id = p.id
     WHERE p.country_code = $1
       AND NOT EXISTS (SELECT 1 FROM place_subcategories x WHERE x.place_id = p.id AND x.is_primary)
     GROUP BY p.id`,
    [countryCode],
  );
  if (rows.length === 0) return 0;
  const keywords = await db.query<{ subcategory_id: number; keywords: string[] }>(
    `SELECT s.id AS subcategory_id,
            array_remove(array_agg(k.keyword) || array_agg(DISTINCT s.display_name), NULL) AS keywords
     FROM subcategories s LEFT JOIN subcategory_keywords k ON k.subcategory_id = s.id AND k.active
     GROUP BY s.id`,
  );
  const keywordsOf = new Map(keywords.rows.map((r) => [r.subcategory_id, r.keywords]));
  const choices = rows
    .map((r) => ({
      placeId: r.place_id,
      subcategoryId: pickPrimarySubcategory(
        r.name_normalized,
        r.subcategory_ids.map((id) => ({ subcategoryId: id, keywords: keywordsOf.get(id) ?? [] })),
      ),
    }))
    .filter((c): c is { placeId: number; subcategoryId: number } => c.subcategoryId !== null);
  if (!dryRun && choices.length > 0) {
    await db.query(
      `UPDATE place_subcategories ps SET is_primary = true
       FROM unnest($1::int[], $2::int[]) AS u(place_id, subcategory_id)
       WHERE ps.place_id = u.place_id AND ps.subcategory_id = u.subcategory_id`,
      [choices.map((c) => c.placeId), choices.map((c) => c.subcategoryId)],
    );
  }
  return choices.length;
}

export interface DedupeSummary {
  groups: DuplicateGroup[];
    /** Same phone nearby, unrelated names: listed for a human, not merged. */
  possible: PossibleDuplicate[];
  /** Places removed by merging (0 in a dry run). */
  merged: number;
  /** Names per group, for the console. */
  names: Map<number, string>;
}

/** Finds duplicate places and (unless dryRun) merges every group into one place. */
export async function dedupePlaces(
  db: Pool,
  countryCode: string,
  rules: LeadRules['dedupe'],
  dryRun: boolean,
): Promise<DedupeSummary> {
  const { rows } = await db.query<{
    id: number;
    name: string;
    name_normalized: string;
    lat: number | null;
    lng: number | null;
    website_domain: string | null;
    phone_e164: string | null;
  }>(
    `SELECT id, name, name_normalized, lat, lng, website_domain, phone_e164
     FROM places WHERE country_code = $1 ORDER BY id`,
    [countryCode],
  );
  const free = await db.query<{ domain: string }>('SELECT domain FROM free_email_domains');
  const { groups, possible } = findDuplicates(
    rows.map((r) => ({
      id: r.id,
      nameNormalized: r.name_normalized,
      lat: r.lat,
      lng: r.lng,
      websiteDomain: r.website_domain,
      phoneE164: r.phone_e164,
    })),
    rules,
    new Set(free.rows.map((r) => r.domain)),
  );
  const names = new Map(rows.map((r) => [r.id, r.name]));
  let merged = 0;
  if (!dryRun) {
    for (const group of groups) {
      const result = await mergePlaceGroup(db, group);
      merged += result?.mergedIds.length ?? 0;
    }
  }
  return { groups, possible, merged, names };
}

export interface ChainSummary {
  byBlocklist: number;
  bySharedDomain: number;
  /** Places whose is_chain value changed (would change in a dry run). */
  changed: number;
  /** Shared domains that made places a chain, with the number of places. */
  domains: [string, number][];
}

/** Recomputes places.is_chain from chain_blocklist and shared website domains. */
export async function applyChains(
  db: Pool,
  countryCode: string,
  rules: LeadRules['chains'],
  dryRun: boolean,
): Promise<ChainSummary> {
  const { rows } = await db.query<{
    id: number;
    name_normalized: string;
    website_domain: string | null;
    is_chain: boolean;
  }>('SELECT id, name_normalized, website_domain, is_chain FROM places WHERE country_code = $1', [
    countryCode,
  ]);
  const blocklist = await db.query<{ name_normalized: string; domain: string | null }>(
    'SELECT name_normalized, domain FROM chain_blocklist',
  );
  const chains = detectChains(
    rows.map((r) => ({
      id: r.id,
      nameNormalized: r.name_normalized,
      websiteDomain: r.website_domain,
    })),
    blocklist.rows.map((b) => ({ nameNormalized: b.name_normalized, domain: b.domain })),
    rules,
  );
  const changed = rows.filter((r) => r.is_chain !== chains.has(r.id));
  if (!dryRun && changed.length > 0) {
    await db.query(
      `UPDATE places p SET is_chain = u.is_chain, updated_at = now()
       FROM unnest($1::int[], $2::bool[]) AS u(id, is_chain) WHERE p.id = u.id`,
      [changed.map((r) => r.id), changed.map((r) => chains.has(r.id))],
    );
  }
  const count = (reason: ChainReason): number =>
    [...chains.values()].filter((r) => r === reason).length;
  const domains = new Map<string, number>();
  for (const r of rows)
    if (chains.get(r.id) === 'SHARED_DOMAIN' && r.website_domain)
      domains.set(r.website_domain, (domains.get(r.website_domain) ?? 0) + 1);
  return {
    byBlocklist: count('BLOCKLIST'),
    bySharedDomain: count('SHARED_DOMAIN'),
    changed: changed.length,
    domains: [...domains.entries()].sort((a, b) => b[1] - a[1]),
  };
}

export interface QualitySummary {
  withEmail: number;
  passed: number;
  needsReview: number;
  reasons: Partial<Record<ReviewReason, number>>;
  changed: number;
  /** Scores of places with an email, for a small distribution. */
  scores: number[];
}

/** Recomputes needs_review, review_reasons and score for every place of a country. */
export async function applyQualityAndScore(
  db: Pool,
  countryCode: string,
  rules: LeadRules,
  dryRun: boolean,
): Promise<QualitySummary> {
  const { rows } = await db.query<{
    id: number;
    city_name: string | null;
    phone_valid: boolean;
    website_domain: string | null;
    rating: number | null;
    rating_count: number | null;
    business_status: string;
    is_chain: boolean;
    needs_review: boolean;
    review_reasons: string[];
    score: number;
    has_category: boolean;
    syntax_valid: boolean | null;
    mx_valid: boolean | null;
    is_own_domain: boolean | null;
    has_primary: boolean;
  }>(
    `SELECT p.id, p.city_name, p.phone_valid, p.website_domain, p.rating, p.rating_count,
            p.business_status, p.is_chain, p.needs_review, p.review_reasons, p.score,
            EXISTS (SELECT 1 FROM place_subcategories ps WHERE ps.place_id = p.id) AS has_category,
            e.syntax_valid, e.mx_valid, e.is_own_domain, e.id IS NOT NULL AS has_primary
     FROM places p LEFT JOIN emails e ON e.place_id = p.id AND e.is_primary
     WHERE p.country_code = $1`,
    [countryCode],
  );
  const summary: QualitySummary = {
    withEmail: 0,
    passed: 0,
    needsReview: 0,
    reasons: {},
    changed: 0,
    scores: [],
  };
  const updates: { id: number; needsReview: boolean; reasons: string[]; score: number }[] = [];
  for (const r of rows) {
    const facts: LeadFacts = {
      cityName: r.city_name,
      countryCode,
      phoneValid: r.phone_valid,
      websiteDomain: r.website_domain,
      rating: r.rating,
      ratingCount: r.rating_count,
      businessStatus: r.business_status,
      isChain: r.is_chain,
      hasCategory: r.has_category,
      primary: r.has_primary
        ? {
            syntaxValid: r.syntax_valid ?? false,
            mxValid: r.mx_valid,
            isOwnDomain: r.is_own_domain ?? false,
          }
        : null,
    };
    const reasons = reviewReasons(facts, rules.quality);
    const score = leadScore(facts, rules.score);
    if (facts.primary) {
      summary.withEmail += 1;
      summary.scores.push(score);
      if (reasons.length === 0) summary.passed += 1;
      else summary.needsReview += 1;
      for (const reason of reasons) summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
    }
    const needsReview = reasons.length > 0;
    if (
      r.needs_review !== needsReview ||
      r.score !== score ||
      r.review_reasons.join(',') !== reasons.join(',')
    )
      updates.push({ id: r.id, needsReview, reasons, score });
  }
  summary.changed = updates.length;
  if (!dryRun) {
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      // text[] per row cannot be passed through unnest directly: send it joined, split again.
      await db.query(
        `UPDATE places p SET needs_review = u.needs_review,
                review_reasons = CASE WHEN u.reasons = '' THEN '{}'::text[] ELSE string_to_array(u.reasons, ',') END,
                score = u.score, updated_at = now()
         FROM unnest($1::int[], $2::bool[], $3::text[], $4::int[]) AS u(id, needs_review, reasons, score)
         WHERE p.id = u.id`,
        [
          batch.map((u) => u.id),
          batch.map((u) => u.needsReview),
          batch.map((u) => u.reasons.join(',')),
          batch.map((u) => u.score),
        ],
      );
    }
  }
  return summary;
}

/**
 * Places that a "new only" export would contain right now (spec §12 default scope):
 * primary email not yet exported and not suppressed, passes the quality gate, not a
 * chain, not closed, status NEW.
 */
export async function countReadyLeads(db: Pool, countryCode: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n
     FROM places p JOIN emails e ON e.place_id = p.id AND e.is_primary
     WHERE p.country_code = $1 AND p.status = 'NEW' AND NOT p.needs_review AND NOT p.is_chain
       AND p.business_status NOT IN ('CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY')
       AND e.exported_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM suppression s
         WHERE s.email_hash = encode(sha256(convert_to(e.email_normalized, 'UTF8')), 'hex')
            OR (s.email_hash IS NULL AND s.domain = e.domain))`,
    [countryCode],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface PipelineSummary {
  primarySubcategories: number;
  dedupe: DedupeSummary;
  chains: ChainSummary;
  quality: QualitySummary;
  ready: number;
}

/**
 * The whole lead-preparation pipeline, in order: de-duplication (merge), primary
 * subcategory, chains, quality gate + score. Safe to run any number of times.
 */
export async function runLeadPipeline(
  db: Pool,
  countryCode: string,
  rules: LeadRules,
  dryRun: boolean,
): Promise<PipelineSummary> {
  const dedupe = await dedupePlaces(db, countryCode, rules.dedupe, dryRun);
  // After merging, so the survivor gets one primary from the union of subcategories.
  const primarySubcategories = await setPrimarySubcategories(db, countryCode, dryRun);
  const chains = await applyChains(db, countryCode, rules.chains, dryRun);
  const quality = await applyQualityAndScore(db, countryCode, rules, dryRun);
  const ready = await countReadyLeads(db, countryCode);
  return { primarySubcategories, dedupe, chains, quality, ready };
}