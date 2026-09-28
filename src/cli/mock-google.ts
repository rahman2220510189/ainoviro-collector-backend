/**
 * Runs the Google Places mock on http://127.0.0.1:5055 with sample Limassol data
 * for the Personal Care & Beauty keywords. Accepts any API key, so your real key
 * can stay in .env; only the base URL changes:
 *   GOOGLE_PLACES_BASE_URL=http://127.0.0.1:5055
 *
 * Usage: npm run mock:google
 */
import { createGoogleMockServer, type MockPlace } from '../dev/google-mock-server';

const PORT = 5055;
/** Inside the Limassol city search box. */
const LIMASSOL = { south: 34.64, west: 32.95, north: 34.75, east: 33.12 };

/** n x n places evenly spread over the Limassol box. */
function grid(keyword: string, n: number, withWebsite = true): MockPlace[] {
  const places: MockPlace[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const id = `mock-${keyword.replace(/\s+/g, '-')}-${i}-${j}`;
      places.push({
        id,
        name: `${keyword} ${i}-${j}`.replace(/\b\w/g, (c) => c.toUpperCase()),
        keyword,
        lat: LIMASSOL.south + ((i + 0.5) / n) * (LIMASSOL.north - LIMASSOL.south),
        lng: LIMASSOL.west + ((j + 0.5) / n) * (LIMASSOL.east - LIMASSOL.west),
        ...(withWebsite && (i + j) % 3 !== 0 ? { website: `https://www.${id}.example.cy/` } : {}),
        phone: `25 ${String(100000 + i * n + j)}`,
      });
    }
  }
  return places;
}

async function main(): Promise<void> {
  const places = [
    ...grid('hair salon', 12), // 144: hits the 60 ceiling, forces splitting
    ...grid('barber shop', 4), // 16
    ...grid('nail salon', 4), // 16
    ...grid('beauty salon', 5), // 25
    ...grid('spa', 3), // 9
    ...grid('makeup artist', 2), // 4
    ...grid('lash studio', 2), // 4
    ...grid('cosmetics store', 3), // 9
    ...grid('beauty supply store', 1), // 1
    ...grid('restaurant', 12), // 144 (other category)
  ];
  const mock = createGoogleMockServer({ places });
  await mock.app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`Google Places MOCK running on http://127.0.0.1:${PORT} (${places.length} fake places)`);
  console.log('Accepts any API key. Nothing is sent to Google. Press Ctrl+C to stop.');
}

main().catch((err: unknown) => {
  console.error('Mock failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});