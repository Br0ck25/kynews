import type { Category } from '../types';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, x-admin-key',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  ...CORS_HEADERS,
};

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...headers,
    },
  });
}

export function badRequest(message: string, details?: unknown): Response {
  return json({ error: message, details: details ?? null }, 400);
}

export async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json<T>()) ?? null;
  } catch {
    return null;
  }
}

export function parsePositiveInt(value: string | null, fallback: number, max = 100): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function parseCommaList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isAllowedCategory(value: string): value is Category {
  return (
    value === 'today' ||
    value === 'national' ||
    value === 'sports' ||
    value === 'weather' ||
    value === 'schools'
  );
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bufferToHex(digest);
}

/**
 * Normalize article URLs so semantically-identical links hash to the same value.
 * This reduces duplicate inserts caused by tracking params, trailing slashes, etc.
 */
export function normalizeCanonicalUrl(input: string): string {
  const raw = (input || '').trim();
  if (!raw) return raw;

  try {
    const parsed = new URL(raw);

    if (!(parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return raw;
    }

    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.hostname.startsWith('www.')) {
      parsed.hostname = parsed.hostname.slice(4);
    }

    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }

    const keptParams: Array<[string, string]> = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      if (isTrackingQueryParam(key)) continue;
      keptParams.push([key, value]);
    }
    keptParams.sort(([a], [b]) => a.localeCompare(b));
    parsed.search = '';
    for (const [key, value] of keptParams) {
      parsed.searchParams.append(key, value);
    }

    let pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
    parsed.pathname = pathname || '/';

    return parsed.toString();
  } catch {
    return raw;
  }
}

export function wordCount(input: string): number {
  const normalized = input.trim().replace(/^#+\s*/gm, '');
  if (!normalized) return 0;
  return normalized.split(/\s+/u).filter(Boolean).length;
}

export function toIsoDate(value: string | number | Date | undefined | null): string {
  return toIsoDateOrNull(value) ?? new Date().toISOString();
}

export function toIsoDateOrNull(value: string | number | Date | undefined | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

interface CachedFetchPayload {
  body: string;
  status: number;
  contentType: string | null;
}

export async function cachedTextFetch(
  env: Env,
  url: string,
  cacheTtlSeconds = 900,
): Promise<CachedFetchPayload> {
  const cacheKey = `fetch:${await sha256Hex(url)}`;
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get<CachedFetchPayload>(cacheKey, 'json');
      if (cached?.body) {
        return cached;
      }
    } catch {
      // best effort cache read
    }
  }

  const response = await fetch(url, {
    headers: {
      'user-agent': 'KentuckyNewsBot/1.0 (+https://kentuckynews.local)',
      accept: 'text/html,application/xhtml+xml,application/xml,text/xml,*/*;q=0.8',
    },
  });

  const payload: CachedFetchPayload = {
    body: await response.text(),
    status: response.status,
    contentType: response.headers.get('content-type'),
  };

  if (env.CACHE && response.ok) {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: cacheTtlSeconds,
      });
    } catch {
      // best effort cache write
    }
  }

  return payload;
}

/**
 * Fetch a URL using realistic browser-like headers to bypass basic bot detection
 * (Cloudflare Bot Fight Mode, simple UA checks, etc.).  Used for manual admin
 * article ingests where the operator explicitly requests a specific URL.
 *
 * Unlike `cachedTextFetch`, this function:
 *  - Uses a realistic Chrome/desktop User-Agent
 *  - Adds Accept-Language and other headers that browsers send
 *  - Does NOT cache the result (manual ingests should always be fresh)
 *  - Returns the same CachedFetchPayload shape for compatibility
 */
export async function browserFetch(url: string): Promise<{
  body: string;
  status: number;
  contentType: string | null;
  blockedByBot: boolean;
}> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      },
      redirect: 'follow',
    });
  } catch (err) {
    throw new Error(`Network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = await response.text();
  const contentType = response.headers.get('content-type');

  // Detect bot-block / JS challenge pages.
  // These typically come as 200 OK but contain no real article content.
  const lowerBody = body.toLowerCase();
  const blockedByBot =
    response.status === 403 ||
    response.status === 429 ||
    (response.status === 200 &&
      body.length < 5000 &&
      (lowerBody.includes('just a moment') ||
        lowerBody.includes('checking your browser') ||
        lowerBody.includes('enable javascript') ||
        lowerBody.includes('cf-ray') ||
        lowerBody.includes('cloudflare') ||
        lowerBody.includes('access denied') ||
        lowerBody.includes('403 forbidden') ||
        lowerBody.includes('bot protection') ||
        lowerBody.includes('please wait')));

  return { body, status: response.status, contentType, blockedByBot };
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chars: string[] = [];
  for (const byte of bytes) {
    chars.push(byte.toString(16).padStart(2, '0'));
  }
  return chars.join('');
}

function isTrackingQueryParam(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.startsWith('utm_') ||
    lower.startsWith('fbclid') ||
    lower.startsWith('gclid') ||
    lower.startsWith('msclkid') ||
    lower.startsWith('mc_') ||
    lower.startsWith('ga_') ||
    lower === 'ref' ||
    lower === 'ref_src' ||
    lower === 'source' ||
    lower === 'outputtype'
  );
}
