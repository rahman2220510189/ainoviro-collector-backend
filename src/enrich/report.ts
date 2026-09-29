import type { EvaluatedEmail, EvaluationResult } from './evaluate';

/** One readable line per email, e.g. "info@shop.cy  PRIMARY own-domain generic MX-ok (mailto)". */
export function describeEmail(email: EvaluatedEmail): string {
  const flags = [
    email.isPrimary ? 'PRIMARY' : null,
    email.isOwnDomain ? 'own-domain' : null,
    email.isFreeMail ? 'free-mail' : null,
    email.isDisposable ? 'DISPOSABLE' : null,
    email.emailType === 'GENERIC' ? 'generic' : 'personal',
    email.mxValid === true ? 'MX-ok' : email.mxValid === false ? 'NO-MX' : 'MX-unknown',
  ].filter((f): f is string => f !== null);
  return `${email.normalized}  ${flags.join(' ')}  (${email.source})`;
}

/** Lines for the console: kept emails, then rejected ones with the reason. */
export function describeEvaluation(evaluation: EvaluationResult, indent = '    '): string[] {
  const lines = evaluation.emails.map((e) => `${indent}${describeEmail(e)}`);
  if (evaluation.emails.length === 0) lines.push(`${indent}(no email found)`);
  // One line per reason, with at most two examples (Wix pages repeat the same junk many times).
  const byReason = new Map<string, string[]>();
  for (const r of evaluation.rejected)
    byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r.email]);
  for (const [reason, emails] of byReason) {
    const examples = emails.slice(0, 2).join(', ') + (emails.length > 2 ? ', ...' : '');
    lines.push(`${indent}rejected ${emails.length} (${reason}): ${examples}`);
  }
  if (evaluation.overLimit > 0)
    lines.push(`${indent}(${evaluation.overLimit} more not kept: limit per site)`);
  return lines;
}