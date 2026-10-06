import { describe, expect, it } from 'vitest';
import { prepareEmails } from '../src/datasets/merge-overture';

describe('prepareEmails (Overture emails before they are stored)', () => {
  it('normalizes, keeps one copy and marks the business own domain', () => {
    const r = prepareEmails(
      ['  Info@Studio-Elena.cy ', 'info@studio-elena.cy', 'maria.k@gmail.com'],
      'studio-elena.cy',
    );
    expect(r.rejected).toBe(0);
    expect(r.emails.map((e) => e.normalized)).toEqual([
      'info@studio-elena.cy',
      'maria.k@gmail.com',
    ]);
    expect(r.emails[0]).toMatchObject({ emailType: 'GENERIC', isOwnDomain: true });
    expect(r.emails[1]).toMatchObject({ isOwnDomain: false });
  });

  it('drops junk: placeholders, image names and things that are not addresses', () => {
    const r = prepareEmails(
      ['name@example.com', 'logo@2x.png', 'not an email', 'hello@cafe-nicosia.cy'],
      null,
    );
    expect(r.emails.map((e) => e.normalized)).toEqual(['hello@cafe-nicosia.cy']);
    expect(r.rejected).toBe(3);
  });

  it('handles a place without emails', () => {
    expect(prepareEmails([], 'shop.cy')).toEqual({ emails: [], rejected: 0 });
  });
});
