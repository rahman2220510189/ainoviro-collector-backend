import { describe, expect, it } from 'vitest';
import { isRoleAddress, pickPrimaryIndex, ROLE_ADDRESS_SQL } from '../src/enrich/classify';
import { reviewReasons, type LeadFacts } from '../src/leads/quality';
import { DEFAULT_LEAD_RULES, leadRulesSchema } from '../src/leads/rules';

describe('data-protection and legal mailboxes (step 7.4)', () => {
  it('recognises privacy@, dpo@, legal@ and similar, not ordinary addresses', () => {
    for (const e of [
      'privacy@bottegaveneta.com',
      'dpo@lawyersan.com',
      'gdpr@shop.cy',
      'data.protection@bank.cy',
      'legal.cy@x.com',
      'dpo2@x.cy',
      'compliance@firm.cy',
    ])
      expect(isRoleAddress(e), e).toBe(true);
    for (const e of ['info@x.cy', 'legalaid.office@x.cy', 'maria@x.cy', 'privatebooking@x.cy'])
      expect(isRoleAddress(e), e).toBe(false);
  });

  it('the SQL pattern agrees with the code', () => {
    const re = new RegExp(ROLE_ADDRESS_SQL);
    expect(re.test('dpo@lawyersan.com')).toBe(true);
    expect(re.test('privacy.eu@x.com')).toBe(true);
    expect(re.test('info@x.cy')).toBe(false);
    expect(re.test('legalaid@x.cy')).toBe(false);
  });

  it('is chosen as primary only when nothing else works', () => {
    const base = { isOwnDomain: true, mxValid: true } as const;
    expect(
      pickPrimaryIndex([
        { ...base, emailType: 'PERSONAL', normalized: 'dpo@lawyersan.com' },
        { ...base, emailType: 'GENERIC', normalized: 'info@lawyersan.com' },
      ]),
    ).toBe(1);
    // ... but still beats an address without a mail server.
    expect(
      pickPrimaryIndex([
        { ...base, mxValid: false, emailType: 'GENERIC', normalized: 'info@x.cy' },
        { ...base, emailType: 'PERSONAL', normalized: 'privacy@x.cy' },
      ]),
    ).toBe(1);
  });

  it('holds a lead whose primary is such a mailbox (switchable in Settings)', () => {
    const facts: LeadFacts = {
      cityName: 'Limassol',
      countryCode: 'CY',
      phoneValid: true,
      websiteDomain: 'lawyersan.com',
      rating: null,
      ratingCount: null,
      businessStatus: 'OPERATIONAL',
      isChain: false,
      hasCategory: true,
      primary: { syntaxValid: true, mxValid: true, isOwnDomain: true, isRoleAddress: true },
    };
    expect(reviewReasons(facts, DEFAULT_LEAD_RULES.quality)).toEqual(['EMAIL_ROLE']);
    const off = leadRulesSchema.parse({ quality: { roleEmail: false } }).quality;
    expect(reviewReasons(facts, off)).toEqual([]);
    // Older saved settings without the new switch: on by default.
    const old = leadRulesSchema.parse({
      quality: {
        emailSyntax: true,
        emailMx: true,
        realCity: true,
        category: false,
        validPhone: true,
      },
    }).quality;
    expect(old.roleEmail).toBe(true);
  });
});
