/**
 * Starts the fake business website on http://127.0.0.1:5056 for crawler demos.
 * It prints every request, so you can see that forbidden pages are never fetched.
 *
 *   npm run dev:test-site                          (Ctrl+C to stop)
 *   npm run dev:test-site -- --js-menu [--sitemap]  homepage menu built by JavaScript
 */
import { parseArgs } from 'node:util';
import { createTestWebsite, DEMO_SITE_ORIGIN, DEMO_SITE_PORT } from '../dev/test-website';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'js-menu': { type: 'boolean', default: false },
      sitemap: { type: 'boolean', default: false },
    },
  });
  const site = createTestWebsite({
    menu: values['js-menu'] ? 'javascript' : 'links',
    sitemap: values.sitemap,
  });
  site.app.addHook('onResponse', async (request, reply) => {
    const time = new Date().toLocaleTimeString('en-GB');
    console.log(
      `[${time}] ${request.method} ${decodeURIComponent(request.url)} -> ${reply.statusCode}`,
    );
  });
  await site.app.listen({ port: DEMO_SITE_PORT, host: '127.0.0.1' });
  console.log(`Demo website running at ${DEMO_SITE_ORIGIN}/ (robots.txt forbids /private/)`);
  if (values['js-menu']) {
    console.log(
      `Menu built by JavaScript; sitemap.xml ${values.sitemap ? 'available' : 'missing'}`,
    );
  }
  console.log('Crawl it from another terminal:');
  console.log(`  npm run crawl:site -- --url ${DEMO_SITE_ORIGIN}/ --demo`);
}

main().catch((err: unknown) => {
  console.error('Demo website failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});