import { describe, expect, it } from 'vitest';
import { hashEmail } from '../src/lib/email';
import { prepareSuppressionRows, readEmailColumn, reasonsReplacedBy } from '../src/services/suppression';
describe('readEmailColumn', () => {
  it('reads a comma CSV with a BOM and a differently-cased header', () => {
    const csv = '\uFEFFName,EMAIL\nAnna,anna@shop.cy\nBob,bob@shop.cy\n';
    expect(readEmailColumn(csv, 'email')).toEqual(['anna@shop.cy', 'bob@shop.cy']);
  });

  it('reads a semicolon CSV with quoted values and a custom column name', () => {
    const csv = 'Name;E-mail Address\n"Anna; Ltd";"anna@shop.cy"\n';
    expect(readEmailColumn(csv, 'E-mail Address')).toEqual(['anna@shop.cy']);
  });

  it('lists the available columns when the column is missing', () => {
    const csv = 'Name,Mail\nAnna,anna@shop.cy\n';
    expect(() => readEmailColumn(csv, 'email')).toThrow(/Columns in this file: name, mail/);
  });
});

describe('prepareSuppressionRows', () => {
  it('normalizes, de-duplicates and reports empty and invalid values', () => {
    const prepared = prepareSuppressionRows([
      'anna@shop.cy',
      ' ANNA@Shop.cy ',
      'mailto:info@cafe.com.cy.',
      '',
      'not-an-email',
    ]);

    expect(prepared.rows).toEqual([
      { emailHash: hashEmail('anna@shop.cy'), emailNormalized: 'anna@shop.cy', domain: 'shop.cy' },
      { emailHash: hashEmail('info@cafe.com.cy'), emailNormalized: 'info@cafe.com.cy', domain: 'cafe.com.cy' },
    ]);
    expect(prepared.duplicatesInFile).toBe(1);
    expect(prepared.emptyValues).toBe(1);
    expect(prepared.invalid).toEqual(['not-an-email']);
    expect(prepared.cellsWithSeveralEmails).toBe(0);
  });

  it('suppresses BOTH addresses of a link whose text and mailto target differ', () => {
    const prepared = prepareSuppressionRows(['[info@ainoviro-test.com](mailto:owner934@example-mail.com)']);
    expect(prepared.rows.map((r) => r.emailNormalized)).toEqual([
      'info@ainoviro-test.com',
      'owner934@example-mail.com',
    ]);
    expect(prepared.cellsWithSeveralEmails).toBe(1);
    expect(prepared.invalid).toEqual([]);
  });
  
describe('reasonsReplacedBy', () => {
  it('lets mailer signals win but never touches ERASED', () => {
    expect(reasonsReplacedBy('UNSUBSCRIBED')).toEqual(['BOUNCED', 'EXISTING_CONTACT', 'EXISTING_VENDOR', 'MANUAL']);
    expect(reasonsReplacedBy('BOUNCED')).toEqual(['EXISTING_CONTACT', 'EXISTING_VENDOR', 'MANUAL']);
    expect(reasonsReplacedBy('EXISTING_CONTACT')).toEqual([]);
    expect(reasonsReplacedBy('UNSUBSCRIBED')).not.toContain('ERASED');
  });
});
});