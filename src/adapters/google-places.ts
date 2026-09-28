import { z } from 'zod';
import type { Bbox } from '../geonames/build';
import {
  GOOGLE_PROVIDER,
  GOOGLE_TEXT_SEARCH_SKU,
  type DenyReason,
  type QuotaDecision,
  type ReserveInput,
} from '../quota/quota-guard';

/**
 * Fields requested from Text Search (New). websiteUri and phone numbers put the
 * request in the Text Search ENTERPRISE SKU (1,000 free per month); rating and
 * userRatingCount are in the same tier, so they add no cost. Never add fields from a
 * higher tier (reviews, photos, editorial summary, ...) without a cost review.
 */
export const TEXT_SEARCH_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.businessStatus',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'nextPageToken',
] as const;
export const TEXT_SEARCH_FIELD_MASK = TEXT_SEARCH_FIELDS.join(',');

export const PAGE_SIZE = 20;
export const MAX_PAGES = 3;
/** Google returns at most 60 results per query (3 pages of 20). */
export const MAX_RESULTS_PER_QUERY = 60;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface TextSearchQuery {
  textQuery: string;
  /** e.g. "en" or "el" */
  languageCode: string;
  /** e.g. "cy" */
  regionCode: string;
  /** Results must lie inside this box (locationRestriction.rectangle). */
  bbox: Bbox;
}

export type BusinessStatusValue = 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY' | 'UNKNOWN';

/** A Google result in our own shape. */
export interface GooglePlace {
  googlePlaceId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
  phoneNational: string | null;
  phoneInternational: string | null;
  businessStatus: BusinessStatusValue;
  rating: number | null;
  ratingCount: number | null;
  types: string[];
  primaryType: string | null;
}

export interface SearchPage {
  places: GooglePlace[];
  nextPageToken: string | null;
  /** HTTP attempts used for this page (retries included). */
  attempts: number;
}

export interface QueryResult {
  places: GooglePlace[];
  pages: number;
  attempts: number;
  /** true when the 60-result ceiling was hit: there may be more places in the area. */
  saturated: boolean;
}

/** Anything that can grant quota (the real QuotaGuard, or a fake in tests). */
export interface QuotaReserver {
  reserve(input: ReserveInput): Promise<QuotaDecision>;
}

/** The QuotaGuard refused: the job must pause, not retry. */
export class QuotaDeniedError extends Error {
  constructor(public readonly reason: DenyReason) {
    super(`Google request not allowed by the quota guard: ${reason}`);
    this.name = 'QuotaDeniedError';
  }
}

export class GooglePlacesError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for a network failure. */
    public readonly httpStatus: number,
    /** true for temporary problems (429, 5xx, network). */
    public readonly retryable: boolean,
    /** Google's error status, e.g. "PERMISSION_DENIED". */
    public readonly googleStatus: string | null = null,
  ) {
    super(message);
    this.name = 'GooglePlacesError';
  }
}

// ---- Response parsing (defensive: every field optional except id) ----------

const googlePlaceSchema = z.object({
  id: z.string(),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  types: z.array(z.string()).optional(),
  primaryType: z.string().optional(),
  businessStatus: z.string().optional(),
  websiteUri: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  internationalPhoneNumber: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
});

const searchResponseSchema = z.object({
  places: z.array(googlePlaceSchema).optional(),
  nextPageToken: z.string().optional(),
});

const googleErrorSchema = z.object({
  error: z.object({ message: z.string().optional(), status: z.string().optional() }).optional(),
});

function toBusinessStatus(value: string | undefined): BusinessStatusValue {
  switch (value) {
    case 'OPERATIONAL':
    case 'CLOSED_TEMPORARILY':
    case 'CLOSED_PERMANENTLY':
      return value;
    default:
      return 'UNKNOWN';
  }
}

function mapPlace(p: z.infer<typeof googlePlaceSchema>): GooglePlace {
  return {
    googlePlaceId: p.id,
    name: p.displayName?.text ?? '',
    address: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    website: p.websiteUri ?? null,
    phoneNational: p.nationalPhoneNumber ?? null,
    phoneInternational: p.internationalPhoneNumber ?? null,
    businessStatus: toBusinessStatus(p.businessStatus),
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    types: p.types ?? [],
    primaryType: p.primaryType ?? null,
  };
}

async function readGoogleError(response: Response): Promise<{ message: string; status: string | null }> {
  try {
    const parsed = googleErrorSchema.parse(await response.json());
    return { message: parsed.error?.message ?? response.statusText, status: parsed.error?.status ?? null };
  } catch {
    return { message: response.statusText, status: null };
  }
}

// ---- Client ------------------------------------------------------------------

export interface GooglePlacesClientOptions {
  apiKey: string;
  baseUrl?: string;
  quota: QuotaReserver;
  /** Lets paid requests use this job's approved extra budget. */
  jobId?: number;
  /** Total attempts per page, including the first (default 3). */
    /** Quota counter name. The mock uses its own, so tests never touch the real one. */
  quotaProvider?: string;
  maxAttempts?: number;
  /** Backoff base in ms: 1x, 2x, 4x ... plus jitter (default 1000). */
  retryBaseMs?: number;
  /** Per-request timeout in ms (default 20000). */
  timeoutMs?: number;
  /** Injected in tests to skip real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class GooglePlacesClient {
  private readonly url: string;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: GooglePlacesClientOptions) {
    const base = (options.baseUrl ?? 'https://places.googleapis.com').replace(/\/+$/, '');
    this.url = `${base}/v1/places:searchText`;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private backoffMs(attempt: number): number {
    const base = this.retryBaseMs * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * this.retryBaseMs);
  }

  /**
   * One page of results. Every HTTP attempt (retries too) first takes a ticket
   * from the quota guard; if it is refused, QuotaDeniedError is thrown and no
   * request is sent.
   */
  async searchPage(query: TextSearchQuery, pageToken?: string): Promise<SearchPage> {
    const body = {
      textQuery: query.textQuery,
      languageCode: query.languageCode,
      regionCode: query.regionCode,
      pageSize: PAGE_SIZE,
      locationRestriction: {
        rectangle: {
          low: { latitude: query.bbox.south, longitude: query.bbox.west },
          high: { latitude: query.bbox.north, longitude: query.bbox.east },
        },
      },
      ...(pageToken ? { pageToken } : {}),
    };

    for (let attempt = 1; ; attempt += 1) {
      const decision = await this.options.quota.reserve({
        provider: this.options.quotaProvider ?? GOOGLE_PROVIDER,
        sku: GOOGLE_TEXT_SEARCH_SKU,
        jobId: this.options.jobId,
      });
      if (!decision.granted) throw new QuotaDeniedError(decision.reason);

      let response: Response;
      try {
        response = await fetch(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': this.options.apiKey,
            'X-Goog-FieldMask': TEXT_SEARCH_FIELD_MASK,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new GooglePlacesError(`Network error calling Google Places: ${reason}`, 0, true);
      }

      if (response.ok) {
        const json = searchResponseSchema.parse(await response.json());
        return {
          places: (json.places ?? []).map(mapPlace),
          nextPageToken: json.nextPageToken ?? null,
          attempts: attempt,
        };
      }

      const retryable = RETRYABLE_STATUS.has(response.status);
      const error = await readGoogleError(response);
      if (retryable && attempt < this.maxAttempts) {
        await this.sleep(this.backoffMs(attempt));
        continue;
      }
      throw new GooglePlacesError(
        `Google Places error ${response.status}${error.status ? ` ${error.status}` : ''}: ${error.message}`,
        response.status,
        retryable,
        error.status,
      );
    }
  }

  /** All pages of one query (up to 3 pages / 60 results). */
  async searchQuery(query: TextSearchQuery, maxPages: number = MAX_PAGES): Promise<QueryResult> {
    const places: GooglePlace[] = [];
    let token: string | null = null;
    let pages = 0;
    let attempts = 0;
    do {
      const page: SearchPage = await this.searchPage(query, token ?? undefined);
      pages += 1;
      attempts += page.attempts;
      places.push(...page.places);
      token = page.nextPageToken;
    } while (token !== null && pages < maxPages);

    return { places, pages, attempts, saturated: places.length >= MAX_RESULTS_PER_QUERY };
  }
}