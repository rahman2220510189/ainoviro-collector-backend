import zlib from 'node:zlib';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

/** Where `npm run dev:test-site` serves the demo site. */
export const DEMO_SITE_PORT = 5056;
export const DEMO_SITE_ORIGIN = `http://127.0.0.1:${DEMO_SITE_PORT}`;
/** The business domain the demo site pretends to have (used in its email addresses). */
export const DEMO_SITE_DOMAIN = 'anna-beauty.test';
/**
 * A small fake business website for crawler tests and local demos, so no real
 * website is ever contacted during development. It counts every request per
 * path, so tests can prove that forbidden pages were never fetched.
 */
export interface TestWebsite {
  app: FastifyInstance;
  /** Requests per path, e.g. hits.get('/contact'). */
  hits: Map<string, number>;
}

export interface TestWebsiteOptions {
  /** robots.txt content; null = answer 404 (no file). */
  robotsTxt?: string | null;
  /** HTTP status for robots.txt (e.g. 503 to simulate a broken server). */
  robotsStatus?: number;
    /** "javascript" = the homepage menu is built by a script, so it has no links to follow. */
  menu?: 'links' | 'javascript';
  /** Serve /sitemap.xml listing the pages (including a contact page at /get-in-touch). */
  sitemap?: boolean;
}

export const DEFAULT_ROBOTS = [
  'User-agent: *',
  'Disallow: /private/',
  '',
  'User-agent: badbot',
  'Disallow: /',
].join('\n');

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body>${body}</body></html>`;

const HOME = page(
  'Anna Beauty Salon Limassol',
  `<header><nav>
     <a href="#top">Top</a>
     <a href="/services">Services</a>
     <a href="/contact">Contact</a>
     <a href="/el/${encodeURIComponent('σχετικά')}">Σχετικά με εμάς</a>
     <a href="/terms">Terms &amp; Conditions</a>
     <a href="/privacy-policy">Privacy</a>
     <a href="/private/team">Contact the team</a>
     <a href="/brochure.pdf">Brochure</a>
     <a href="https://www.instagram.com/annabeauty">Instagram</a>
     <a href="mailto:hello@anna-beauty.test">Email us</a>
     <a href="tel:+35799123456">Call</a>
   </nav></header>
   <main><h1>Anna Beauty Salon</h1><p>Hair, nails and make-up in Limassol since 2010.</p></main>`,
);
/** Cloudflare-style "email protection" encoding (XOR with a one-byte key, hex). */
export function encodeCloudflareEmail(email: string, key = 0x5a): string {
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return hex(key) + [...Buffer.from(email, 'utf8')].map((b) => hex(b ^ key)).join('');
}

/**
 * Contact page with every way an address can appear, plus typical junk that
 * must NOT be collected (image name, template placeholder, monitoring key).
 */
const CONTACT = page(
  'Contact',
  `<h1>Contact us</h1>
   <p>Write to <a href="mailto:Info@Anna-Beauty.test?subject=Hello">Info@Anna-Beauty.test</a></p>
   <p>Owner: maria [at] anna-beauty [dot] test</p>
   <p>Bookings: <a href="/cdn-cgi/l/email-protection#${encodeCloudflareEmail('bookings@anna-beauty.test')}">[email&#160;protected]</a></p>
   <p>Our accountant: anna.accounts&#64;gmail.com</p>
   <figure><img src="/img/logo@2x.png" alt=""><figcaption>logo@2x.png</figcaption></figure>
   <p class="hint">Example: name@example.com</p>
   <div hidden>0123456789abcdef0123@sentry-next.wixpress.com</div>
      <span data-email="reception&#64;anna-beauty.test">Reception</span>
   <script>window.siteData = {"contactEmail":"studio\\u0040anna-beauty.test","builtBy":"developer@webagency.cy"};</script>
   <script type="application/ld+json">
     {"@context":"https://schema.org","@type":"BeautySalon","name":"Anna Beauty",
      "contactPoint":{"@type":"ContactPoint","email":"mailto:hello@anna-beauty.test"}}
   </script>`,
);
/** Homepage whose menu is created by JavaScript: no <a> links in the HTML. */
const HOME_JS_MENU = page(
  'Anna Beauty Salon Limassol',
  `<div id="menu"></div>
   <script>document.getElementById('menu').innerHTML = '<a href="/contact">Contact</a>';</script>
   <main><h1>Anna Beauty Salon</h1><p>Hair, nails and make-up in Limassol since 2010.</p></main>`,
);
export function createTestWebsite(options: TestWebsiteOptions = {}): TestWebsite {
  const app = Fastify({ logger: false });
  const hits = new Map<string, number>();
  const robotsTxt = options.robotsTxt === undefined ? DEFAULT_ROBOTS : options.robotsTxt;

  app.addHook('onRequest', async (request) => {
    const path = decodeURIComponent(request.url.split('?')[0] ?? '/');
    hits.set(path, (hits.get(path) ?? 0) + 1);
  });

  app.get('/robots.txt', async (_request, reply) => {
    if (options.robotsStatus) return reply.code(options.robotsStatus).send('error');
    if (robotsTxt === null) return reply.code(404).send('not found');
    return reply.type('text/plain').send(robotsTxt);
  });

  const html = (body: string) => async (_request: unknown, reply: FastifyReply) =>
    reply.type('text/html; charset=utf-8').send(body);

  app.get('/', html(options.menu === 'javascript' ? HOME_JS_MENU : HOME));
  app.get('/get-in-touch', html(CONTACT));
  app.get('/sitemap.xml', async (request, reply) => {
    if (!options.sitemap) return reply.code(404).send('not found');
    const urls = ['/', '/services', '/get-in-touch', '/terms'];
    return reply
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          urls.map((u) => `<url><loc>http://${request.headers.host}${u}</loc></url>`).join('') +
          '</urlset>',
      );
  });
  app.get('/services', html(page('Services', '<p>Haircut, colour, nails.</p>')));
  app.get('/contact', html(CONTACT));
  app.get('/terms', html(page('Terms', '<p>Terms of service.</p>')));
  app.get('/privacy-policy', html(page('Privacy', '<p>Privacy policy.</p>')));
  app.get('/private/team', html(page('Team', '<p>This page is forbidden by robots.txt.</p>')));

  // A Greek page in the old windows-1253 encoding (common on older Cypriot sites).
  app.get('/el/σχετικά', async (_request, reply) => {
    const text =
      '<html><head><meta charset="windows-1253"><title>Σχετικά</title></head>' +
      '<body><p>Κομμωτήριο Άννα, Λεμεσός</p></body></html>';
    const bytes = Buffer.from([...text].map((ch) => encodeWindows1253(ch)));
    return reply.type('text/html').send(bytes);
  });

  // Compressed page.
  app.get('/gzip', async (_request, reply) => {
    const body = zlib.gzipSync(Buffer.from(page('Gzip', '<p>compressed page</p>')));
    return reply.header('content-encoding', 'gzip').type('text/html; charset=utf-8').send(body);
  });

  // Redirect chain: /redirect/3 -> /redirect/2 -> /redirect/1 -> /redirect/0 -> /
  app.get<{ Params: { n: string } }>('/redirect/:n', async (request, reply) => {
    const n = Number(request.params.n);
    return reply.redirect(n <= 0 ? '/' : `/redirect/${n - 1}`, 302);
  });
  // Redirect to a private address (must be refused by the SSRF guard).
  app.get('/redirect-private', async (_request, reply) =>
    reply.redirect('http://127.0.0.1/admin', 302),
  );

  // A page far larger than the size limit.
  app.get('/huge', async (_request, reply) =>
    reply.type('text/html').send(`<html><body>${'x'.repeat(3_000_000)}</body></html>`),
  );
  // A page that answers too slowly.
  app.get('/slow', async (_request, reply) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return reply.type('text/html').send(page('Slow', '<p>late</p>'));
  });
  app.get('/image.png', async (_request, reply) =>
    reply.type('image/png').send(Buffer.from([137, 80, 78, 71])),
  );
  app.get('/server-error', async (_request, reply) => reply.code(503).send('down'));

  return { app, hits };
}

/** Minimal windows-1253 encoder for the characters used on the Greek test page. */
function encodeWindows1253(ch: string): number {
  const code = ch.codePointAt(0) ?? 0x3f;
  if (code < 0x80) return code;
  if (code === 0x386) return 0xa2; // Ά
  if (code >= 0x388 && code <= 0x3ce) return code - 0x2d0; // Έ..ώ
  return 0x3f; // "?"
}