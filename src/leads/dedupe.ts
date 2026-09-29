import { distanceKm } from '../cleaning/city';
import type { LeadRules } from './rules';

/** What de-duplication needs to know about a place. */
export interface DedupePlace {
  id: number;
  nameNormalized: string;
  lat: number | null;
  lng: number | null;
  /** Own website domain (platform links are already NULL). */
  websiteDomain: string | null;
  phoneE164: string | null;
}

export type MatchReason = 'DOMAIN' | 'PHONE' | 'NAME';

/** Two places with the same phone nearby but unrelated names: shown, never merged. */
export interface PossibleDuplicate {
  ids: [number, number];
  reason: 'PHONE';
}

export interface DuplicateResult {
  groups: DuplicateGroup[];
  possible: PossibleDuplicate[];
}

export interface DuplicateGroup {
  /** Place ids, ascending. */
  ids: number[];
  /** Why places were joined (each reason once, in spec order). */
  reasons: MatchReason[];
}

/**
 * Words that say where or what a business is, not who it is: "Anna Beauty Limassol"
 * and "Anna Beauty" are the same name. Compared after normalization (lowercase, no accents).
 */
const NOISE_WORDS = new Set(
  (
    'limassol lemesos nicosia lefkosia larnaca larnaka paphos pafos famagusta ammochostos ' +
    'ayia napa protaras paralimni kyrenia cyprus kypros cy λεμεσος λευκωσια λαρνακα παφος ' +
    'αμμοχωστος κυπρος the and by & - | branch'
  ).split(' '),
);

/** Name used for similarity: normalized, punctuation removed, place words dropped. */
export function comparableName(nameNormalized: string): string {
  const words = nameNormalized
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w !== '' && !NOISE_WORDS.has(w));
  return words.join(' ');
}

function bigrams(text: string): Map<string, number> {
  const compact = text.replace(/\s+/g, '');
  const grams = new Map<string, number>();
  for (let i = 0; i < compact.length - 1; i += 1) {
    const g = compact.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/** Dice coefficient on character pairs of the comparable names: 1 = same, 0 = nothing shared. */
export function nameSimilarity(a: string, b: string): number {
  const x = comparableName(a);
  const y = comparableName(b);
  if (x === '' || y === '') return 0;
  if (x === y) return 1;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let shared = 0;
  let total = 0;
  for (const n of gx.values()) total += n;
  for (const n of gy.values()) total += n;
  for (const [g, n] of gx) shared += Math.min(n, gy.get(g) ?? 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * Words many businesses share ("hair", "nails", "studio"): a match on them alone does not
 * mean two names belong to the same business.
 */
const GENERIC_WORDS = new Set(
  (
    'beauty salon salons studio studios hair hairs nail nails lash lashes brow brows makeup ' +
    'make up spa academy center centre clinic body face skin care barber barbers barbershop ' +
    'shop boutique lounge bar house club atelier artist artists aesthetics aesthetic cosmetics ' +
    'institute school permanent style styling design unisex by and the of for with'
  ).split(' '),
);

/**
 * Two names share a word that identifies the business: "Makeup by Christina Tsangara" and
 * "Ctsangara Makeup" share "tsangara" (inside "ctsangara"); "Glamour Lashes" and
 * "Sei Bella Nails" share nothing. Generic words and words shorter than 3 letters do not count.
 */
export function sharesDistinctiveWord(a: string, b: string): boolean {
  const words = (name: string): string[] =>
    comparableName(name)
      .split(' ')
      .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  const wa = words(a);
  const wb = words(b);
  return wa.some((x) =>
    wb.some((y) => x === y || (x.length >= 5 && y.includes(x)) || (y.length >= 5 && x.includes(y))),
  );
}

function metersBetween(a: DedupePlace, b: DedupePlace): number | null {
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null;
  return distanceKm(a.lat, a.lng, b.lat, b.lng) * 1000;
}

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    let root = x;
    while ((this.parent.get(root) ?? root) !== root) root = this.parent.get(root) ?? root;
    this.parent.set(x, root);
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
}

/**
 * Finds places that are the same business (spec §11 matching order after source ids,
 * which the UNIQUE columns already guarantee):
 *  - same own website domain (not a free-mail domain) AND within sameKeyMaxMeters;
 *  - same phone (E.164) AND within sameKeyMaxMeters;
 *  - very similar name AND within sameNameMaxMeters.
 * The distance limit keeps branches of one company apart (they share a website and
 * often a phone); the chain rule handles those. Without coordinates, a shared domain
 * or phone counts only when the names are also similar.
 */
export function findDuplicateGroups(
  places: DedupePlace[],
  rules: LeadRules['dedupe'],
  freeDomains: ReadonlySet<string> = new Set(),
): DuplicateGroup[] {
  return findDuplicates(places, rules, freeDomains).groups;
}

/**
 * Like findDuplicateGroups, and also returns "possible duplicates": the same phone nearby
 * with names that share no identifying word. A phone can be shared by two businesses in
 * one studio or passed on to a new owner, so these are listed for a human, not merged.
 */
export function findDuplicates(
  places: DedupePlace[],
  rules: LeadRules['dedupe'],
  freeDomains: ReadonlySet<string> = new Set(),
): DuplicateResult {
  const possible: PossibleDuplicate[] = [];
  const uf = new UnionFind();
  const reasons = new Map<number, Set<MatchReason>>();
  const join = (a: DedupePlace, b: DedupePlace, reason: MatchReason): void => {
    uf.union(a.id, b.id);
    for (const id of [a.id, b.id]) reasons.set(id, (reasons.get(id) ?? new Set()).add(reason));
  };

  const byKey = (key: (p: DedupePlace) => string | null): Map<string, DedupePlace[]> => {
    const map = new Map<string, DedupePlace[]>();
    for (const p of places) {
      const k = key(p);
      if (k) map.set(k, [...(map.get(k) ?? []), p]);
    }
    return map;
  };
  const strongKeys: [MatchReason, Map<string, DedupePlace[]>][] = [
    [
      'DOMAIN',
      byKey((p) => (p.websiteDomain && !freeDomains.has(p.websiteDomain) ? p.websiteDomain : null)),
    ],
    ['PHONE', byKey((p) => p.phoneE164)],
  ];
  for (const [reason, groups] of strongKeys) {
    for (const members of groups.values()) {
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const a = members[i] as DedupePlace;
          const b = members[j] as DedupePlace;
          const meters = metersBetween(a, b);
          const close =
            meters === null
              ? nameSimilarity(a.nameNormalized, b.nameNormalized) >= rules.nameSimilarity
              : meters <= rules.sameKeyMaxMeters;
          if (!close) continue;
          if (reason === 'PHONE' && !sharesDistinctiveWord(a.nameNormalized, b.nameNormalized))
            possible.push({ ids: [a.id, b.id], reason });
          else join(a, b, reason);
        }
      }
    }
  }

  // Similar names: compare only places in neighbouring grid cells (about 220 m wide).
  const cell = 0.002;
  const grid = new Map<string, DedupePlace[]>();
  const cellOf = (p: DedupePlace): [number, number] => [
    Math.floor((p.lat ?? 0) / cell),
    Math.floor((p.lng ?? 0) / cell),
  ];
  const located = places.filter((p) => p.lat !== null && p.lng !== null);
  for (const p of located) {
    const [x, y] = cellOf(p);
    grid.set(`${x}:${y}`, [...(grid.get(`${x}:${y}`) ?? []), p]);
  }
  const reach = Math.max(1, Math.ceil(rules.sameNameMaxMeters / 1000 / (cell * 111)));
  for (const a of located) {
    const [x, y] = cellOf(a);
    for (let dx = -reach; dx <= reach; dx += 1) {
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (const b of grid.get(`${x + dx}:${y + dy}`) ?? []) {
          if (b.id <= a.id) continue;
          const meters = metersBetween(a, b);
          if (meters === null || meters > rules.sameNameMaxMeters) continue;
          if (nameSimilarity(a.nameNormalized, b.nameNormalized) >= rules.nameSimilarity)
            join(a, b, 'NAME');
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (const id of reasons.keys()) {
    const root = uf.find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  const order: MatchReason[] = ['DOMAIN', 'PHONE', 'NAME'];
  const merged = [...groups.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => {
      const found = new Set(ids.flatMap((id) => [...(reasons.get(id) ?? [])]));
      return { ids: ids.sort((a, b) => a - b), reasons: order.filter((r) => found.has(r)) };
    })
    .sort((a, b) => (a.ids[0] ?? 0) - (b.ids[0] ?? 0));
  // A pair that was joined another way (e.g. same website) is not "possible" any more.
  const stillSeparate = possible.filter(
    ({ ids: [x, y] }) => !reasons.has(x) || !reasons.has(y) || uf.find(x) !== uf.find(y),
  );
  return { groups: merged, possible: stillSeparate };
}

/** What choosing the surviving place of a group needs. */
export interface SurvivorCandidate {
  id: number;
  status: string;
  hasPrimaryEmail: boolean;
}

/**
 * The place that stays after a merge: one already worked on (exported, contacted,
 * rejected ...) keeps its history, then one with a primary email, then the oldest.
 */
export function chooseSurvivor(candidates: SurvivorCandidate[]): number {
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(b.status !== 'NEW') - Number(a.status !== 'NEW') ||
      Number(b.hasPrimaryEmail) - Number(a.hasPrimaryEmail) ||
      a.id - b.id,
  );
  const first = ranked[0];
  if (!first) throw new Error('chooseSurvivor needs at least one place');
  return first.id;
}