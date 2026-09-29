import { promises as dnsPromises } from 'node:dns';

/** Looks up MX records; replaceable in tests so no real DNS is used. */
export type MxResolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

const TRANSIENT = new Set([
  'ETIMEOUT',
  'ESERVFAIL',
  'ECONNREFUSED',
  'ECANCELLED',
  'EREFUSED',
  'ETIMEDOUT',
]);

export function defaultMxResolver(): MxResolver {
  const resolver = new dnsPromises.Resolver({ timeout: 5000, tries: 2 });
  return (domain) => resolver.resolveMx(domain);
}

/**
 * Answers "can this domain receive email?" from DNS MX records, with a cache so
 * each domain is looked up once per process (gmail.com is asked once, not 500 times).
 *  - true:  at least one real MX record;
 *  - false: domain does not exist, has no MX, or publishes a "null MX" (RFC 7505);
 *  - null:  DNS did not answer (timeout); unknown, try again later.
 * No SMTP probing (spec: v1 is syntax + MX only).
 */
export class MxChecker {
  private readonly cache = new Map<string, Promise<boolean | null>>();

  constructor(private readonly resolve: MxResolver = defaultMxResolver()) {}

  check(domain: string): Promise<boolean | null> {
    const key = domain.toLowerCase();
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.lookup(key);
      this.cache.set(key, pending);
      // Unknown answers are not cached, so a later call can try again.
      void pending.then((value) => {
        if (value === null) this.cache.delete(key);
      });
    }
    return pending;
  }

  private async lookup(domain: string): Promise<boolean | null> {
    try {
      const records = await this.resolve(domain);
      return records.some((r) => r.exchange !== '' && r.exchange !== '.');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      return TRANSIENT.has(code) ? null : false;
    }
  }
}