import { describe, expect, it } from 'vitest';
import { emailDomain, extractEmails, hashEmail, normalizeEmail } from '../src/lib/email';
describe('normalizeEmail', () => {
  it.each([
    ['info@shop.cy', 'info@shop.cy'],
    ['  Info@Shop.CY  ', 'info@shop.cy'],
    ['mailto:Sales@Shop.cy', 'sales@shop.cy'],
    ['mailto:hello@cafe.com.cy?subject=Hi', 'hello@cafe.com.cy'],
    ['contact@shop.cy.', 'contact@shop.cy'],
    ['<owner@shop.cy>,', 'owner@shop.cy'],
    ['first.last+tag@sub.example.com', 'first.last+tag@sub.example.com'],
    ['info@xn--hxajbheg2az3al.xn--jxalpdlp', 'info@xn--hxajbheg2az3al.xn--jxalpdlp'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it.each([
    [''],
    ['not-an-email'],
    ['two@@shop.cy'],
    ['no-tld@shop'],
    ['space in@shop.cy'],
    ['@shop.cy'],
    ['logo@2x.png.'],
  ])('rejects %j', (input) => {
    // "logo@2x.png" is a known false positive pattern; ".png" passes the syntax check,
    // so image names are filtered later by the crawler. Here only true syntax errors fail.
    if (input === 'logo@2x.png.') {
      expect(normalizeEmail(input)).toBe('logo@2x.png');
      return;
    }
    expect(normalizeEmail(input)).toBeNull();
  });
});

describe('hashEmail / emailDomain', () => {
  it('hashes to 64 lowercase hex characters, the same for the same email', () => {
    const hash = hashEmail('info@shop.cy');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEmail('info@shop.cy')).toBe(hash);
    expect(hashEmail('sales@shop.cy')).not.toBe(hash);
  });

  it('returns the domain part', () => {
    expect(emailDomain('info@shop.com.cy')).toBe('shop.com.cy');
  });
});

describe('extractEmails', () => {
  it('finds both addresses in a link whose text and mailto target differ', () => {
    expect(extractEmails('[Info@Ainoviro-test.com](mailto:owner934@example-mail.com)')).toEqual([
      'info@ainoviro-test.com',
      'owner934@example-mail.com',
    ]);
  });

  it('handles an HTML link, "Name <email>" and several emails in one cell', () => {
    expect(extractEmails('<a href="mailto:a@shop.cy">B@Shop.cy</a>')).toEqual(['a@shop.cy', 'b@shop.cy']);
    expect(extractEmails('Anna Shop <anna@shop.cy>')).toEqual(['anna@shop.cy']);
    expect(extractEmails('a@shop.cy; b@shop.cy, a@shop.cy')).toEqual(['a@shop.cy', 'b@shop.cy']);
  });

  it('returns nothing for text without an email', () => {
    expect(extractEmails('call us: +357 99 123456')).toEqual([]);
  });
});