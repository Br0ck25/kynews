import { XMLParser } from "fast-xml-parser";
import { toHttpsUrl } from "../lib/text";

export interface ParsedFeedItem {
  title: string;
  link: string;
  guid: string | null;
  isoDate: string | null;
  pubDate: string | null;
  contentSnippet: string | null;
  content: string | null;
  author: string | null;
  imageUrl: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  removeNSPrefix: false
});

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"] as string;
    if (typeof obj["__cdata"] === "string") return obj["__cdata"] as string;
    if (typeof obj.href === "string") return obj.href;
    if (typeof obj.url === "string") return obj.url;
  }
  return "";
}

function pickLink(link: unknown): string {
  if (!link) return "";
  if (typeof link === "string") return link;
  if (Array.isArray(link)) {
    const alt = link.find((x) => String((x as any)?.rel || "alternate") === "alternate");
    const candidate = alt || link[0];
    if (candidate && typeof candidate === "object") {
      return textOf((candidate as any).href || (candidate as any).url || (candidate as any)["#text"] || "");
    }
    return textOf(candidate);
  }
  if (typeof link === "object") {
    return textOf((link as any).href || (link as any).url || (link as any)["#text"] || "");
  }
  return "";
}

function extractImageFromHtml(html: string): string | null {
  if (!html) return null;
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  const src = match?.[1]?.trim();
  if (!src) return null;
  return toHttpsUrl(src);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function pickDate(values: Array<string | null | undefined>): { iso: string | null; raw: string | null } {
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const iso = normalizeDate(raw);
    if (iso) return { iso, raw };
  }
  return { iso: null, raw: null };
}

function pickImage(item: Record<string, unknown>): string | null {
  const enclosures = toArray(item.enclosure as Record<string, unknown> | Array<Record<string, unknown>> | undefined);
  for (const enclosure of enclosures) {
    const mediaUrl = toHttpsUrl(String(enclosure?.url || ""));
    if (mediaUrl) return mediaUrl;
  }

  const mediaContent = item["media:content"] as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  for (const media of toArray(mediaContent)) {
    const mediaUrl = toHttpsUrl(String(media?.url || ""));
    if (mediaUrl) return mediaUrl;
  }

  const mediaThumb = item["media:thumbnail"] as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  for (const media of toArray(mediaThumb)) {
    const mediaUrl = toHttpsUrl(String(media?.url || ""));
    if (mediaUrl) return mediaUrl;
  }

  const itunes = item["itunes:image"] as Record<string, unknown> | undefined;
  const itunesUrl = toHttpsUrl(String(itunes?.href || ""));
  if (itunesUrl) return itunesUrl;

  const content = textOf(item["content:encoded"] || item.content || item.description || "");
  return extractImageFromHtml(content);
}

function mapRssItem(item: Record<string, unknown>): ParsedFeedItem {
  const content = textOf(item["content:encoded"] || item.content || item.description || "") || null;
  const snippet = textOf(item.description || item.summary || item.contentSnippet || "") || null;
  const date = pickDate([
    textOf(item.isoDate),
    textOf(item.pubDate),
    textOf(item["dc:date"]),
    textOf(item.published),
    textOf(item.updated),
    textOf(item.date)
  ]);

  return {
    title: textOf(item.title) || "(untitled)",
    link: pickLink(item.link || item.guid),
    guid: textOf(item.guid) || null,
    isoDate: date.iso,
    pubDate: date.raw,
    contentSnippet: snippet ? stripHtml(snippet).slice(0, 2000) : null,
    content: content ? content.slice(0, 50_000) : null,
    author: textOf(item["dc:creator"] || item.creator || item.author) || null,
    imageUrl: pickImage(item)
  };
}

function mapAtomItem(entry: Record<string, unknown>): ParsedFeedItem {
  const content = textOf(entry.content || "") || null;
  const summary = textOf(entry.summary || "") || null;
  const date = pickDate([
    textOf(entry.updated),
    textOf(entry.published),
    textOf(entry["dc:date"]),
    textOf(entry.date)
  ]);

  return {
    title: textOf(entry.title) || "(untitled)",
    link: pickLink(entry.link || entry.id),
    guid: textOf(entry.id) || null,
    isoDate: date.iso,
    pubDate: date.raw,
    contentSnippet: summary ? stripHtml(summary).slice(0, 2000) : null,
    content: content ? content.slice(0, 50_000) : summary,
    author: textOf((entry.author as any)?.name || entry.author) || null,
    imageUrl: pickImage(entry)
  };
}

export function parseFeedItems(xml: string): ParsedFeedItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;

  const rssItems = toArray((doc.rss as any)?.channel?.item);
  if (rssItems.length) {
    return rssItems
      .map((item) => mapRssItem(item as Record<string, unknown>))
      .filter((item) => item.link || item.guid || item.title);
  }

  const atomEntries = toArray((doc.feed as any)?.entry);
  if (atomEntries.length) {
    return atomEntries
      .map((entry) => mapAtomItem(entry as Record<string, unknown>))
      .filter((item) => item.link || item.guid || item.title);
  }

  return [];
}
