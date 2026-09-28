import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { guardedLookup, isBlockedAddress } from './ip-guard';

export type FetchErrorCode =
  | 'BAD_URL'
  | 'BLOCKED_ADDRESS'
  | 'BLOCKED_PORT'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'TOO_MANY_REDIRECTS'
  | 'WRONG_CONTENT_TYPE'
  | 'NETWORK';

export class FetchError extends Error {
  constructor(
    public readonly code: FetchErrorCode,
    message: string,
    /** true for problems that may go away later (timeouts, network errors). */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** "html" accepts only web pages; "text" accepts any text (robots.txt). */
  expect: 'html' | 'text';
  /**
   * ONLY for automated tests and the local demo site: exact origins (e.g.
   * "http://127.0.0.1:5056") that may be reached although they are private.
   * Every other address is still checked, including redirect targets.
   */
  testOrigins?: string[];
}

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  /** Every URL visited before the final one. */
  redirects: string[];
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

/** true when this URL is one of the explicitly allowed local test origins. */
function isTestOrigin(url: URL, options: FetchOptions): boolean {
  return options.testOrigins?.includes(url.origin) ?? false;
}

function checkTarget(url: URL, options: FetchOptions): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError('BAD_URL', `Only http and https are allowed: ${url.protocol}`, false);
  }
  if (isTestOrigin(url, options)) return;
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new FetchError('BLOCKED_PORT', `Port ${url.port} is not allowed`, false);
  }
  // IP literals skip DNS, so they are checked here directly.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) {
    throw new FetchError('BLOCKED_ADDRESS', `${host} is a private or reserved address`, false);
  }
}

/** Charset from the Content-Type header, else from a <meta> tag near the top of the page. */
export function detectCharset(contentType: string | null, head: Buffer): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const sniff = head.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

function decodeBody(buffer: Buffer, contentType: string | null): string {
  const charset = detectCharset(contentType, buffer);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    // Unknown charset label: UTF-8 is the best guess.
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function decompress(response: IncomingMessage): Readable {
  const encoding = (response.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return response.pipe(zlib.createInflate());
  if (encoding === 'br') return response.pipe(zlib.createBrotliDecompress());
  return response;
}

interface RawResponse {
  status: number;
  location: string | null;
  contentType: string | null;
  body: Buffer;
}

/** One HTTP request (no redirect handling), with size and time limits. */
function requestOnce(url: URL, options: FetchOptions, deadline: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new FetchError('TIMEOUT', `Timed out after ${options.timeoutMs} ms`, true));
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': options.userAgent,
          Accept:
            options.expect === 'html'
              ? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'
              : 'text/plain,*/*;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en,el;q=0.8',
        },
        lookup: isTestOrigin(url, options) ? undefined : guardedLookup,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;
        const contentType = response.headers['content-type'] ?? null;
        // Redirect bodies are not needed.
        if (status >= 300 && status < 400 && location) {
          response.resume();
          resolve({ status, location, contentType, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const stream = decompress(response);
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            request.destroy(
              new FetchError('TOO_LARGE', `Page is larger than ${options.maxBytes} bytes`, false),
            );
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () =>
          resolve({ status, location, contentType, body: Buffer.concat(chunks) }),
        );
        stream.on('error', (err) => request.destroy(err));
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new FetchError('TIMEOUT', `Timed out after ${options.timeoutMs} ms`, true));
    }, remaining);
    request.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err instanceof FetchError) reject(err);
      else if (err.code === 'BLOCKED_ADDRESS')
        reject(new FetchError('BLOCKED_ADDRESS', err.message, false));
      else if (err.code === 'ENOTFOUND')
        reject(new FetchError('NETWORK', `Domain not found: ${url.hostname}`, false));
      else reject(new FetchError('NETWORK', err.message, true));
    });
    request.on('close', () => clearTimeout(timer));
    request.end();
  });
}

/**
 * Fetches one page safely: http/https only, public IP addresses only (checked
 * again after every redirect), at most `maxRedirects` redirects, a size limit
 * applied AFTER decompression, one overall time limit, and correct decoding of
 * Greek pages (windows-1253 / ISO-8859-7 / UTF-8).
 * Non-2xx responses are returned (with status), not thrown.
 */
export async function fetchPage(rawUrl: string, options: FetchOptions): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchError('BAD_URL', `Not a valid URL: ${rawUrl}`, false);
  }
  const deadline = Date.now() + options.timeoutMs;
  const redirects: string[] = [];

  for (;;) {
    checkTarget(url, options);
    const response = await requestOnce(url, options, deadline);

    if (response.status >= 300 && response.status < 400 && response.location) {
      if (redirects.length >= options.maxRedirects) {
        throw new FetchError(
          'TOO_MANY_REDIRECTS',
          `More than ${options.maxRedirects} redirects`,
          false,
        );
      }
      redirects.push(url.toString());
      try {
        url = new URL(response.location, url);
      } catch {
        throw new FetchError('BAD_URL', `Invalid redirect target: ${response.location}`, false);
      }
      url.hash = '';
      continue;
    }

    const ok = response.status >= 200 && response.status < 300;
    const mime = (response.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (ok && options.expect === 'html' && mime !== '' && !HTML_TYPES.includes(mime)) {
      throw new FetchError('WRONG_CONTENT_TYPE', `Not a web page: ${mime}`, false);
    }
    return {
      url: url.toString(),
      status: response.status,
      contentType: response.contentType,
      body: decodeBody(response.body, response.contentType),
      redirects,
    };
  }
}