import crypto from "node:crypto";

export function stableHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function makeItemId({ url, guid, title, published_at }) {
  // Prefer URL (canonical). Fallback to guid, then title+date.
  const base = url || guid || `${title || ""}__${published_at || ""}`;
  return stableHash(base).slice(0, 24);
}

export function pickImage(item) {
  // Best-effort; many feeds differ.
  // rss-parser may expose enclosure, itunes:image, media:content, etc.
  const enc = item.enclosure?.url;
  if (enc && /^https?:\/\//i.test(enc)) return enc;

  const media = item["media:content"]?.url || item["media:thumbnail"]?.url;
  if (media && /^https?:\/\//i.test(media)) return media;

  const itunes = item["itunes:image"]?.href;
  if (itunes && /^https?:\/\//i.test(itunes)) return itunes;

  // Try to find img in content snippet (lightweight)
  const html = item.content || item.contentSnippet || "";
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m?.[1]) return m[1];

  return null;
}

export function toIsoOrNull(dateLike) {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
