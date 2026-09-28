import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

/**
 * A local imitation of Places API (New) Text Search for tests and development.
 * It checks the API key and field mask, honours locationRestriction.rectangle,
 * paginates 20 per page up to 60, and can replay queued failures (429, 503, ...).
 * It never contacts Google.
 */

export interface MockPlace {
  id: string;
  name: string;
  /** The exact textQuery (lowercase) that finds this place. */
  keyword: string;
  lat: number;
  lng: number;
  website?: string;
  /** National format, e.g. "25 123456". */
  phone?: string;
  status?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
}

export interface MockFailure {
  status: number;
  googleStatus: string;
  message: string;
}

interface MockRequestBody {
  textQuery?: string;
  pageSize?: number;
  pageToken?: string;
  languageCode?: string;
  regionCode?: string;
  locationRestriction?: {
    rectangle?: {
      low?: { latitude: number; longitude: number };
      high?: { latitude: number; longitude: number };
    };
  };
}

export interface RecordedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: MockRequestBody;
}

export interface GoogleMock {
  app: FastifyInstance;
  requests: RecordedRequest[];
  /** Failures are replayed in order, one per request, before normal answers. */
  failures: MockFailure[];
}

function sendGoogleError(reply: FastifyReply, status: number, googleStatus: string, message: string) {
  return reply.status(status).send({ error: { code: status, message, status: googleStatus } });
}

function toGoogleShape(p: MockPlace) {
  return {
    id: p.id,
    displayName: { text: p.name, languageCode: 'en' },
    formattedAddress: `${p.name}, Cyprus`,
    location: { latitude: p.lat, longitude: p.lng },
    types: [p.keyword.replace(/\s+/g, '_'), 'establishment'],
    primaryType: p.keyword.replace(/\s+/g, '_'),
    businessStatus: p.status ?? 'OPERATIONAL',
    rating: 4.5,
    userRatingCount: 12,
    ...(p.website ? { websiteUri: p.website } : {}),
    ...(p.phone ? { nationalPhoneNumber: p.phone, internationalPhoneNumber: `+357 ${p.phone}` } : {}),
  };
}

export function createGoogleMockServer(options: {
  apiKey?: string;
  places: MockPlace[];
  failures?: MockFailure[];
}): GoogleMock {
  const app = Fastify({ logger: false });
  const mock: GoogleMock = { app, requests: [], failures: [...(options.failures ?? [])] };

  // "::" escapes the colon, so the route is the literal path /v1/places:searchText.
  app.post('/v1/places::searchText', async (request, reply) => {
    const body = (request.body ?? {}) as MockRequestBody;
    mock.requests.push({ headers: request.headers, body });

    const sentKey = request.headers['x-goog-api-key'];
    if (!sentKey || (options.apiKey !== undefined && sentKey !== options.apiKey)) {
      return sendGoogleError(reply, 403, 'PERMISSION_DENIED', 'API key not valid. Please pass a valid API key.');
    }
    if (!request.headers['x-goog-fieldmask']) {
      return sendGoogleError(reply, 400, 'INVALID_ARGUMENT', 'FieldMask is a required parameter.');
    }
    const failure = mock.failures.shift();
    if (failure) return sendGoogleError(reply, failure.status, failure.googleStatus, failure.message);

    const low = body.locationRestriction?.rectangle?.low;
    const high = body.locationRestriction?.rectangle?.high;
    if (!low || !high) {
      return sendGoogleError(reply, 400, 'INVALID_ARGUMENT', 'This mock requires locationRestriction.rectangle.');
    }

    const query = (body.textQuery ?? '').trim().toLowerCase();
    const matches = options.places
      .filter(
        (p) =>
          p.keyword === query &&
          p.lat >= low.latitude &&
          p.lat <= high.latitude &&
          p.lng >= low.longitude &&
          p.lng <= high.longitude,
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 60); // Google's ceiling per query

    const pageSize = Math.min(Math.max(Number(body.pageSize ?? 20), 1), 20);
    const offset = body.pageToken ? Number(Buffer.from(body.pageToken, 'base64').toString('utf8')) : 0;
    const page = matches.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    const nextPageToken =
      nextOffset < matches.length ? Buffer.from(String(nextOffset)).toString('base64') : undefined;

    return { places: page.map(toGoogleShape), ...(nextPageToken ? { nextPageToken } : {}) };
  });

  return mock;
}