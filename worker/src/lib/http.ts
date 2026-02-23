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

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
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
    value === 'schools' ||
    value === 'obituaries'
  );
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bufferToHex(digest);
}

export function wordCount(input: string): number {
  const normalized = input.trim();
  if (!normalized) return 0;
  return normalized.split(/\s+/u).filter(Boolean).length;
}

export function toIsoDate(value: string | number | Date | undefined | null): string {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
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

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chars: string[] = [];
  for (const byte of bytes) {
    chars.push(byte.toString(16).padStart(2, '0'));
  }
  return chars.join('');
}
