import type { AppContext } from "../types";
import { sha256Hex } from "../lib/crypto";

type CachedEnvelope = {
  etag: string;
  payload: string;
  cachedAt: string;
};

function isCacheBypass(c: AppContext): boolean {
  if (c.req.method !== "GET") return true;
  if (c.req.header("x-admin-token")) return true;
  if (c.req.header("cf-access-authenticated-user-email")) return true;
  return false;
}

function makeCacheKey(url: URL): string {
  const sorted = [...url.searchParams.entries()]
    .sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  return `api-cache:v2:${url.pathname}?${sorted}`;
}

function setSharedHeaders(c: AppContext, etag: string, ttlSeconds: number, staleSeconds: number): void {
  c.header("etag", etag);
  c.header("cache-control", `public, max-age=${Math.min(ttlSeconds, 60)}, s-maxage=${ttlSeconds}, stale-while-revalidate=${staleSeconds}`);
}

export async function respondCachedJson(
  c: AppContext,
  options: {
    ttlSeconds: number;
    staleSeconds?: number;
    cacheKey?: string;
    producer: () => Promise<Record<string, unknown>>;
  }
): Promise<Response> {
  const staleSeconds = options.staleSeconds ?? Math.max(60, Math.floor(options.ttlSeconds / 2));
  const url = new URL(c.req.url);
  const cacheKey = options.cacheKey || makeCacheKey(url);
  const bypass = isCacheBypass(c);

  if (!bypass) {
    const existingRaw = await c.env.CACHE.get(cacheKey);
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw) as CachedEnvelope;
        const ifNoneMatch = c.req.header("if-none-match");
        if (ifNoneMatch && ifNoneMatch === existing.etag) {
          setSharedHeaders(c, existing.etag, options.ttlSeconds, staleSeconds);
          return c.body(null, 304);
        }

        setSharedHeaders(c, existing.etag, options.ttlSeconds, staleSeconds);
        c.header("x-cache", "HIT");
        return c.json(JSON.parse(existing.payload));
      } catch {
        // fall through to regenerate
      }
    }
  }

  const data = await options.producer();
  const payload = JSON.stringify(data);
  const etag = `"${(await sha256Hex(payload)).slice(0, 32)}"`;

  setSharedHeaders(c, etag, options.ttlSeconds, staleSeconds);
  c.header("x-cache", "MISS");

  if (!bypass) {
    const env: CachedEnvelope = { etag, payload, cachedAt: new Date().toISOString() };
    await c.env.CACHE.put(cacheKey, JSON.stringify(env), {
      expirationTtl: Math.max(options.ttlSeconds + staleSeconds, options.ttlSeconds + 60)
    });
  }

  return c.body(payload, 200, { "content-type": "application/json; charset=utf-8" });
}
