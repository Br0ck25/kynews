import { d1First, d1Run } from "./db";
import { badRequest } from "../lib/errors";
import { logWarn } from "../lib/logger";
import { toHttpsUrl } from "../lib/text";
import type { Env } from "../types";

const IMAGE_TIMEOUT_MS = 12_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function extFromContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return "jpg";
  if (ct.includes("image/png")) return "png";
  if (ct.includes("image/webp")) return "webp";
  if (ct.includes("image/gif")) return "gif";
  if (ct.includes("image/avif")) return "avif";
  return "bin";
}

function extFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "jpg";
  if (lower.includes(".png")) return "png";
  if (lower.includes(".webp")) return "webp";
  if (lower.includes(".gif")) return "gif";
  if (lower.includes(".avif")) return "avif";
  return "jpg";
}

export function toMediaPath(key: string): string {
  return `/api/media/${encodeURIComponent(key)}`;
}

export async function mirrorArticleImageToR2(
  env: Env,
  input: { itemId: string; sourceUrl: string | null | undefined }
): Promise<string | null> {
  const sourceUrl = toHttpsUrl(input.sourceUrl);
  if (!sourceUrl) return null;

  const existing = await d1First<{ source_url: string; r2_key: string }>(
    env.ky_news_db,
    "SELECT source_url, r2_key FROM item_media WHERE item_id=? LIMIT 1",
    [input.itemId]
  );
  if (existing?.r2_key && existing.source_url === sourceUrl) {
    return toMediaPath(existing.r2_key);
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);

  try {
    const res = await fetch(sourceUrl, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; EKY-News-Worker/1.0)",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
      }
    });

    if (!res.ok) return null;

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) return null;

    const ext = extFromContentType(contentType) || extFromUrl(sourceUrl);
    const key = `news/${input.itemId}.${ext}`;

    await env.ky_news_media.put(key, bytes, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=2592000, immutable"
      },
      customMetadata: {
        item_id: input.itemId,
        source_url: sourceUrl
      }
    });

    await d1Run(
      env.ky_news_db,
      `INSERT INTO item_media (item_id, source_url, r2_key, content_type, bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(item_id) DO UPDATE SET
         source_url=excluded.source_url,
         r2_key=excluded.r2_key,
         content_type=excluded.content_type,
         bytes=excluded.bytes,
         updated_at=excluded.updated_at`,
      [input.itemId, sourceUrl, key, contentType, bytes.length]
    );

    await d1Run(env.ky_news_db, "UPDATE items SET image_url=? WHERE id=?", [toMediaPath(key), input.itemId]);

    return toMediaPath(key);
  } catch (err) {
    logWarn("media.mirror.failed", {
      itemId: input.itemId,
      sourceUrl,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function assertSafeObjectKey(rawKey: string): string {
  const key = decodeURIComponent(String(rawKey || ""));
  if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes("..")) {
    badRequest("Invalid object key");
  }
  return key;
}
