import { describe, expect, it } from 'vitest';
import {
  chooseSurvivor,
  comparableName,
  findDuplicateGroups,
  findDuplicates,
  nameSimilarity,
  sharesDistinctiveWord,
  type DedupePlace,
} from '../src/leads/dedupe';
import {
  detectChains,
  isRealCity,
  leadScore,
  pickPrimarySubcategory,
  reviewReasons,
  type LeadFacts,
} from '../src/leads/quality';
import { DEFAULT_LEAD_RULES, leadRulesSchema } from '../src/leads/rules';

// Limassol seafront; 0.001 degrees of latitude is about 111 m.
const LAT = 34.6786;
const LNG = 33.0413;

function place(id: number, name: string, extra: Partial<DedupePlace> = {}): DedupePlace {
  return {
    id,
    nameNormalized: name,
    lat: LAT,
    lng: LNG,
    websiteDomain: null,
    phoneE164: null,
    ...extra,
  };
}

const groupsOf = (places: DedupePlace[]) =>
  findDuplicateGroups(places, DEFAULT_LEAD_RULES.dedupe, new Set(['gmail.com']));

describe('lead rules', () => {
  it('uses the spec defaults when nothing is stored', () => {
    expect(DEFAULT_LEAD_RULES.chains.minPlacesPerDomain).toBe(3);
    expect(DEFAULT_LEAD_RULES.score).toMatchObject({ ownDomainEmail: 30, chain: -50 });
    expect(Object.values(DEFAULT_LEAD_RULES.quality).every(Boolean)).toBe(true);
  });

  it('keeps defaults for values a stored setting leaves out', () => {
    const rules = leadRulesSchema.parse({ quality: { validPhone: false } });
    expect(rules.quality).toMatchObject({ validPhone: false, emailMx: true });
    expect(rules.dedupe.sameNameMaxMeters).toBe(200);
  });
});

describe('name similarity', () => {
  it('ignores place words and punctuation', () => {
    expect(comparableName('anna beauty - limassol')).toBe('anna beauty');
    expect(nameSimilarity('anna beauty limassol', 'anna beauty')).toBe(1);
  });

  it('scores small spelling differences high and different names low', () => {
    expect(nameSimilarity('curly ginger beauty salon', 'curly-ginger beauty salon')).toBe(1);
    expect(nameSimilarity('nail lounge by olga', 'nail lounge olga')).toBeGreaterThan(0.85);
    expect(nameSimilarity('mo nails', 'oh my lash')).toBeLessThan(0.5);
    // Place words of another country (loaded per country) are ignored the same way.
    const greek = new Set(['thessaloniki', 'athens']);
    expect(nameSimilarity('anna beauty thessaloniki', 'anna beauty', greek)).toBe(1);
    expect(nameSimilarity('anna beauty thessaloniki', 'anna beauty')).toBeLessThan(1);
  });
});

describe('findDuplicateGroups', () => {
  it('joins the same own domain nearby', () => {
    const groups = groupsOf([
      place(1, 'ledi beauty', { websiteDomain: 'ledi.cy' }),
      place(2, 'ledi body salon', { websiteDomain: 'ledi.cy', lat: LAT + 0.001 }),
    ]);
    expect(groups).toEqual([{ ids: [1, 2], reasons: ['DOMAIN'] }]);
  });

  it('keeps branches of one company apart (same domain, far away)', () => {
    const groups = groupsOf([
      place(1, 'blow limassol', { websiteDomain: 'blowhairsalon.com' }),
      place(2, 'blow nicosia', { websiteDomain: 'blowhairsalon.com', lat: 35.1856, lng: 33.3823 }),
    ]);
    expect(groups).toEqual([]);
  });

  it('joins the same phone nearby, and never by a free-mail "domain"', () => {
    const groups = groupsOf([
      place(1, 'studio maria', { phoneE164: '+35799123456', websiteDomain: 'gmail.com' }),
      place(2, 'hair by maria', { phoneE164: '+35799123456', websiteDomain: 'gmail.com' }),
      place(3, 'other shop', { websiteDomain: 'gmail.com' }),
    ]);
    expect(groups).toEqual([{ ids: [1, 2], reasons: ['PHONE'] }]);
  });

  it('joins very similar names within 200 m only', () => {
    const groups = groupsOf([
      place(1, 'oldboy premium barbershop'),
      place(2, 'oldboy premium barbershop limassol', { lng: LNG + 0.001 }),
      place(3, 'oldboy premium barbershop', { lat: LAT + 0.01 }),
    ]);
    expect(groups).toEqual([{ ids: [1, 2], reasons: ['NAME'] }]);
  });

  it('does not join different businesses in the same building', () => {
    expect(groupsOf([place(1, 'mo nails'), place(2, 'oh my lash')])).toEqual([]);
  });

  it('chains matches transitively into one group', () => {
    const groups = groupsOf([
      place(1, 'siel beauty zone', { websiteDomain: 'sielbeautysalon.com' }),
      place(2, 'siel beauty', { websiteDomain: 'sielbeautysalon.com', phoneE164: '+35725000000' }),
      place(3, 'siel', { phoneE164: '+35725000000' }),
    ]);
    expect(groups).toEqual([{ ids: [1, 2, 3], reasons: ['DOMAIN', 'PHONE'] }]);
  });

  it('without coordinates a shared domain needs a similar name', () => {
    const noCoords = { lat: null, lng: null };
    expect(
      groupsOf([
        place(1, 'you beauty', { ...noCoords, websiteDomain: 'you.com.cy' }),
        place(2, 'you beauty', { ...noCoords, websiteDomain: 'you.com.cy' }),
        place(3, 'completely different', { ...noCoords, websiteDomain: 'you.com.cy' }),
      ]),
    ).toEqual([{ ids: [1, 2], reasons: ['DOMAIN'] }]);
  });
});

describe('chooseSurvivor', () => {
  it('prefers a place already worked on, then one with email, then the oldest', () => {
    expect(
      chooseSurvivor([
        { id: 1, status: 'NEW', hasPrimaryEmail: true },
        { id: 2, status: 'EXPORTED', hasPrimaryEmail: false },
      ]),
    ).toBe(2);
    expect(
      chooseSurvivor([
        { id: 1, status: 'NEW', hasPrimaryEmail: false },
        { id: 5, status: 'NEW', hasPrimaryEmail: true },
      ]),
    ).toBe(5);
    expect(
      chooseSurvivor([
        { id: 7, status: 'NEW', hasPrimaryEmail: false },
        { id: 3, status: 'NEW', hasPrimaryEmail: false },
      ]),
    ).toBe(3);
  });
});

describe('detectChains', () => {
  const rules = DEFAULT_LEAD_RULES.chains;

  it('marks a domain used by 3+ places, not by 2', () => {
    const chains = detectChains(
      [
        { id: 1, nameNormalized: 'a', websiteDomain: 'bhb.com.cy' },
        { id: 2, nameNormalized: 'b', websiteDomain: 'bhb.com.cy' },
        { id: 3, nameNormalized: 'c', websiteDomain: 'big.cy' },
        { id: 4, nameNormalized: 'd', websiteDomain: 'big.cy' },
        { id: 5, nameNormalized: 'e', websiteDomain: 'big.cy' },
      ],
      [],
      rules,
    );
    expect([...chains.entries()]).toEqual([
      [3, 'SHARED_DOMAIN'],
      [4, 'SHARED_DOMAIN'],
      [5, 'SHARED_DOMAIN'],
    ]);
  });

  it('matches the blocklist by whole first words or by domain', () => {
    const chains = detectChains(
      [
        { id: 1, nameNormalized: 'zara home limassol', websiteDomain: null },
        { id: 2, nameNormalized: 'zarafa beauty', websiteDomain: null },
        { id: 3, nameNormalized: 'x', websiteDomain: 'sephora.cy' },
      ],
      [
        { nameNormalized: 'zara', domain: null },
        { nameNormalized: 'sephora', domain: 'www.sephora.cy' },
      ],
      rules,
    );
    expect([...chains.entries()]).toEqual([
      [1, 'BLOCKLIST'],
      [3, 'BLOCKLIST'],
    ]);
  });
});

function facts(extra: Partial<LeadFacts> = {}): LeadFacts {
  return {
    cityName: 'Limassol',
    countryCode: 'CY',
    phoneValid: true,
    websiteDomain: 'shop.cy',
    rating: 4.8,
    ratingCount: 40,
    businessStatus: 'OPERATIONAL',
    isChain: false,
    hasCategory: true,
    primary: { syntaxValid: true, mxValid: true, isOwnDomain: true },
    ...extra,
  };
}

describe('quality gate', () => {
  const rules = DEFAULT_LEAD_RULES.quality;

  it('passes a complete lead', () => {
    expect(reviewReasons(facts(), rules)).toEqual([]);
  });

  it('lists every failed rule', () => {
    expect(
      reviewReasons(
        facts({
          cityName: 'Cyprus',
          phoneValid: false,
          hasCategory: false,
          primary: { syntaxValid: false, mxValid: false, isOwnDomain: false },
        }),
        rules,
      ),
    ).toEqual(['EMAIL_SYNTAX', 'EMAIL_NO_MX', 'NO_REAL_CITY', 'NO_CATEGORY', 'PHONE_INVALID']);
    expect(
      reviewReasons(
        facts({ primary: { syntaxValid: true, mxValid: null, isOwnDomain: true } }),
        rules,
      ),
    ).toEqual(['EMAIL_MX_UNKNOWN']);
  });

  it('does not review places without an email', () => {
    expect(reviewReasons(facts({ primary: null, phoneValid: false }), rules)).toEqual([]);
  });

  it('respects switched-off rules', () => {
    expect(reviewReasons(facts({ phoneValid: false }), { ...rules, validPhone: false })).toEqual(
      [],
    );
  });

  it('knows what a real city is', () => {
    expect(isRealCity('Limassol', 'CY')).toBe(true);
    expect(isRealCity('Λεμεσός', 'CY')).toBe(true);
    for (const bad of [null, '', 'unknown', 'Cyprus', 'Κύπρος', 'CY']) {
      expect(isRealCity(bad, 'CY')).toBe(false);
    }
  });
});

describe('lead score', () => {
  const rules = DEFAULT_LEAD_RULES.score;

  it('adds the spec weights', () => {
    expect(leadScore(facts(), rules)).toBe(30 + 15 + 10 + 10 + 10);
    expect(leadScore(facts({ isChain: true }), rules)).toBe(75 - 50);
  });

  it('needs rating >= 4.0 AND at least 5 ratings', () => {
    expect(leadScore(facts({ rating: 4.9, ratingCount: 4 }), rules)).toBe(65);
    expect(leadScore(facts({ rating: 3.9, ratingCount: 100 }), rules)).toBe(65);
  });

  it('gives nothing for a free-mail email, no website or a closed business', () => {
    expect(
      leadScore(
        facts({
          primary: { syntaxValid: true, mxValid: true, isOwnDomain: false },
          websiteDomain: null,
          businessStatus: 'CLOSED_TEMPORARILY',
        }),
        rules,
      ),
    ).toBe(20);
  });
});

describe('pickPrimarySubcategory', () => {
  const candidates = [
    { subcategoryId: 10, keywords: ['hair salon', 'κομμωτήριο'] },
    { subcategoryId: 20, keywords: ['nail salon', 'manicure'] },
  ];

  it('prefers the subcategory named in the business name', () => {
    expect(pickPrimarySubcategory('mo nails international', candidates)).toBe(20);
    expect(pickPrimarySubcategory('κομμωτήριο ελένη', candidates)).toBe(10);
  });

  it('falls back to the first subcategory found', () => {
    expect(pickPrimarySubcategory('you', candidates)).toBe(10);
    expect(pickPrimarySubcategory('you', [])).toBeNull();
  });
});

describe('same phone, different names (first real dry run)', () => {
  const phone = { phoneE164: '+35799111111' };
  const run = (a: string, b: string) =>
    findDuplicates(
      [place(1, a, phone), place(2, b, { ...phone, lng: LNG + 0.0005 })],
      DEFAULT_LEAD_RULES.dedupe,
    );

  it('merges when the names share an identifying word', () => {
    expect(
      run('makeup by christina tsangara', 'ctsangara makeup lash & brow artist').groups,
    ).toEqual([{ ids: [1, 2], reasons: ['PHONE'] }]);
    expect(run('eva body and nails', 'eva nail academy').groups).toHaveLength(1);
  });

  it('only lists unrelated names as possible duplicates', () => {
    for (const [a, b] of [
      ['glamour lashes & brows studio', 'sei bella nails & beauty salon by alina'],
      ['theh hair club limassol', "groove's hair studio"],
    ]) {
      const result = run(a as string, b as string);
      expect(result.groups).toEqual([]);
      expect(result.possible).toEqual([{ ids: [1, 2], reason: 'PHONE' }]);
    }
  });

  it('knows identifying words', () => {
    expect(sharesDistinctiveWord('oldboy barbershop', 'oldboy premium')).toBe(true);
    expect(sharesDistinctiveWord('hair studio', 'hair salon')).toBe(false);
  });
});
