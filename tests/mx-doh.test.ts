import { describe, expect, it } from 'vitest';
import { MxChecker, dohMxResolver } from '../src/enrich/mx';

const json = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('mail-server check falls back to DNS over HTTPS', () => {
  it('reads MX answers, NXDOMAIN and empty answers', async () => {
    const ok = dohMxResolver(json({ Status: 0, Answer: [{ type: 15, data: '10 mx.shop.cy.' }] }));
    expect(await ok('shop.cy')).toEqual([{ priority: 10, exchange: 'mx.shop.cy' }]);
    await expect(dohMxResolver(json({ Status: 3 }))('nope.cy')).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
    await expect(dohMxResolver(json({ Status: 0, Answer: [] }))('x.cy')).rejects.toMatchObject({
      code: 'ENODATA',
    });
  });

  it('asks the fallback only when the system DNS gives no answer', async () => {
    const timeout = async () => {
      throw Object.assign(new Error('t'), { code: 'ETIMEOUT' });
    };
    const viaFallback = new MxChecker(timeout, async () => [{ exchange: 'mx.a.cy', priority: 1 }]);
    expect(await viaFallback.check('a.cy')).toBe(true);

    const bothSilent = new MxChecker(timeout, timeout);
    expect(await bothSilent.check('b.cy')).toBeNull();

    let asked = false;
    const noMx = new MxChecker(
      async () => {
        throw Object.assign(new Error('n'), { code: 'ENOTFOUND' });
      },
      async () => {
        asked = true;
        return [];
      },
    );
    expect(await noMx.check('c.cy')).toBe(false);
    expect(asked).toBe(false); // a clear "no" from system DNS is final

    // A custom resolver without a fallback (tests) never goes to the network.
    expect(await new MxChecker(timeout).check('d.cy')).toBeNull();
  });
});
