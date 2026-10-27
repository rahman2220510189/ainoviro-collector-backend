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

/** Error with a DNS-style code, so DoH answers are handled like system DNS answers. */
function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * MX lookup over HTTPS (Google Public DNS). Used only when the system DNS gives no answer:
 * some hosting networks time out on DNS, which left emails "not checked" (held for review).
 */
export function dohMxResolver(fetchFn: typeof fetch = fetch): MxResolver {
  return async (domain) => {
    const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`;
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw dnsError('ETIMEOUT');
    }
    if (!res.ok) throw dnsError('ESERVFAIL');
    const body = (await res.json()) as {
      Status?: number;
      Answer?: { type?: number; data?: string }[];
    };
    if (body.Status === 3) throw dnsError('ENOTFOUND'); // NXDOMAIN: the domain does not exist
    if (body.Status !== 0) throw dnsError('ESERVFAIL');
    const records = (body.Answer ?? [])
      .filter((a) => a.type === 15 && typeof a.data === 'string')
      .map((a) => {
        const [priority = '0', exchange = ''] = (a.data as string).split(/\s+/);
        return { priority: Number(priority), exchange: exchange.replace(/\.$/, '') };
      });
    if (records.length === 0) throw dnsError('ENODATA');
    return records;
  };
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

  private readonly resolve: MxResolver;
  private readonly fallback: MxResolver | null;

  /**
   * @param resolve  system DNS by default (replaced in tests)
   * @param fallback asked when `resolve` gives no answer; DNS over HTTPS by default,
   *                 none when a custom `resolve` is passed without a fallback (tests)
   */
  constructor(resolve?: MxResolver, fallback?: MxResolver | null) {
    this.resolve = resolve ?? defaultMxResolver();
    this.fallback = fallback !== undefined ? fallback : resolve ? null : dohMxResolver();
  }

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
    const first = await MxChecker.ask(this.resolve, domain);
    if (first !== null || !this.fallback) return first;
    return MxChecker.ask(this.fallback, domain);
  }

  private static async ask(resolve: MxResolver, domain: string): Promise<boolean | null> {
    try {
      const records = await resolve(domain);
      return records.some((r) => r.exchange !== '' && r.exchange !== '.');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      return TRANSIENT.has(code) ? null : false;
    }
  }
}
