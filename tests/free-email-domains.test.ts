import { describe, expect, it } from 'vitest';
import { freeEmailDomainsFileSchema, loadFreeEmailDomains } from '../src/services/free-email-domains';

describe('seed/free_email_domains.json', () => {
  it('is valid and contains the key providers', () => {
    const domains = loadFreeEmailDomains();
    expect(domains).toContain('gmail.com');
    expect(domains).toContain('cytanet.com.cy');
  });

  it('rejects uppercase and duplicate domains', () => {
    expect(() => freeEmailDomainsFileSchema.parse({ version: 1, domains: ['Gmail.com'] })).toThrow();
    expect(() =>
      freeEmailDomainsFileSchema.parse({ version: 1, domains: ['gmail.com', 'gmail.com'] }),
    ).toThrow(/duplicate domain/);
  });
});