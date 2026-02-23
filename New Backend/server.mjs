/**
 * New Backend – Node.js HTTP Server (Fastify)
 * ============================================
 * Replaces apps/api/src/server.mjs.
 *
 * Key differences from the old server:
 *  - Uses db-adapter.mjs (supports SQLite for local dev, D1 for Cloudflare)
 *  - Sub-modules (weather, lostFound, seo, schema) receive a sync-compatible
 *    openDb factory backed by better-sqlite3 (same interface as before)
 *  - All new routes use the adapter's interface (synchronous in SQLite mode)
 *  - Import paths reach sibling apps/ directories via relative paths
 *
 * Environment variables:
 *  DB_PATH                    – path to SQLite file  (default: data/dev.sqlite)
 *  PORT                       – HTTP listen port     (default: 8787)
 *  HOST                       – bind address         (default: 127.0.0.1)
 *  LOCAL_DATA_ENCRYPTION_KEY  – AES-256-GCM key for PII fields
 *  ADMIN_TOKEN                – bearer token for admin routes
 *  ADMIN_EMAIL                – email label for admin-token auth
 *  SITE_URL                   – canonical site URL   (default: https://localky.news)
 *  SITE_ORIGIN                – canonical origin     (default: https://localkynews.com)
 *  NWS_USER_AGENT             – NWS API user-agent string
 *  REQUIRE_TURNSTILE          – set "1" to require CF Turnstile token on LF submissions
 *  CF_ACCESS_AUTHENTICATED_USER_EMAIL – header set by Cloudflare Access
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── DB adapter (primary: for main routes) ────────────────────────────────────
// openDb({ path }) is async (dynamic import for better-sqlite3 tree-shaking),
// but once resolved all statement methods are synchronous in SQLite mode.
import { openDb as openDbAdapter } from "./db-adapter.mjs";

// ── Direct better-sqlite3 import for legacy sub-modules that need a sync openDb
// (weather.mjs, lostFound.mjs, seo.mjs, schema.mjs all call openDb() synchronously).
import Database from "better-sqlite3";

// ── Legacy module imports (apps/api/src/) ────────────────────────────────────
import { ensureSchema } from "../apps/api/src/schema.mjs";
import {
  buildSearchClause,
  isKy,
  mapItemRow,
  normalizeCounty,
  detectKyCounties,
  detectOtherStateNames,
  hasKySignal,
  detectKyQueryCounties
} from "../apps/api/src/search.mjs";
import { insertAdminLog, requireAdmin } from "../apps/api/src/security.mjs";
import { registerWeatherRoutes } from "../apps/api/src/weather.mjs";
import { registerLostFoundRoutes } from "../apps/api/src/lostFound.mjs";
import { registerSeoRoutes } from "../apps/api/src/seo.mjs";

// ── Content-tagging (ingester shared util) ────────────────────────────────────
import { computeContentTags } from "../apps/ingester/src/contentTags.mjs";
import kyCounties from "../apps/ingester/src/ky-counties.json" with { type: "json" };
import kyCityCounty from "../apps/ingester/src/ky-city-county.json" with { type: "json" };

// ─────────────────────────────────────────────────────────────────────────────
// Path constants
// ─────────────────────────────────────────────────────────────────────────────

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");
const uploadDir = path.resolve(repoRoot, "data", "uploads", "lost-found");
const ingesterScript = path.resolve(repoRoot, "apps", "ingester", "src", "ingester.mjs");

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(repoRoot, "data", "dev.sqlite");

await fs.mkdir(uploadDir, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// DB factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Async factory using db-adapter (future-compatible with D1).
 * Returns a SQLiteDb whose methods are synchronous in Node.js mode.
 */
async function openDb() {
  return openDbAdapter({ path: DB_PATH });
}

/**
 * Synchronous factory for legacy sub-modules (weather, lostFound, seo, schema).
 * Returns a native better-sqlite3 Database with WAL + foreign keys enabled.
 * This retains 100% backward-compatibility with the existing sub-module code.
 */
function syncOpenDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time startup: ensure schema exists
// ─────────────────────────────────────────────────────────────────────────────

{
  const db = syncOpenDb();
  ensureSchema(db);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fastify app setup
// ─────────────────────────────────────────────────────────────────────────────

const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });

await app.register(cors, {
  origin: [
    /^http:\/\/localhost:\d+$/,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    /^http:\/\/\[::1\]:\d+$/
  ],
  credentials: false
});

await app.register(sensible);

app.addContentTypeParser(/^image\/.*/, { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});

// ─────────────────────────────────────────────────────────────────────────────
// Config constants
// ─────────────────────────────────────────────────────────────────────────────

const NEWS_SCOPES = ["ky", "national", "all"];
const PAID_SOURCE_DOMAINS = [
  "bizjournals.com",
  "courier-journal.com",
  "dailyindependent.com",
  "franklinfavorite.com",
  "kentucky.com",
  "kentuckynewera.com",
  "messenger-inquirer.com",
  "news-expressky.com",
  "paducahsun.com",
  "richmondregister.com",
  "salyersvilleindependent.com",
  "state-journal.com",
  "thenewsenterprise.com",
  "timesleader.net"
];
const HEAVY_DEPRIORITIZED_PAID_DOMAINS = ["dailyindependent.com"];
const PAID_FALLBACK_LIMIT = 2;
const PAID_FALLBACK_WHEN_EMPTY_LIMIT = 3;
const MIN_ITEM_WORDS = 50;
const DEFAULT_SITE_URL = "https://localky.news";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getSiteUrl() {
  return String(process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/g, "");
}

function countyNameToSlug(name) {
  const normalized = String(name || "")
    .trim()
    .replace(/\s+county$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return "";
  return `${normalized}-county`;
}

const KY_COUNTY_SLUGS = Array.from(
  new Set(
    (Array.isArray(kyCounties) ? kyCounties : [])
      .map((row) => countyNameToSlug(row?.name))
      .filter(Boolean)
  )
);

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseIso(value) {
  const d = new Date(String(value || ""));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function buildSitemapUrlTag({ loc, changefreq, priority, lastmod }) {
  const lines = ["  <url>", `    <loc>${xmlEscape(loc)}</loc>`];
  if (lastmod) lines.push(`    <lastmod>${xmlEscape(lastmod)}</lastmod>`);
  if (changefreq) lines.push(`    <changefreq>${xmlEscape(changefreq)}</changefreq>`);
  if (priority != null) lines.push(`    <priority>${Number(priority).toFixed(1)}</priority>`);
  lines.push("  </url>");
  return lines.join("\n");
}

function parseCountyList(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(",");
  const out = [];
  for (const value of raw) {
    const county = normalizeCounty(value);
    if (!county) continue;
    if (!out.includes(county)) out.push(county);
  }
  return out;
}

function parseItemsCursor(cursor) {
  if (!cursor) return null;
  const raw = String(cursor);
  const [ts, id] = raw.split("|");
  if (!ts) return null;
  return { ts, id: id || null };
}

function sourceHost(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function canonicalUrl(url) {
  try {
    const u = new URL(String(url || ""));
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_eid$|mkt_tok$)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    u.hash = "";
    const pathname = u.pathname.replace(/\/+$/, "");
    u.pathname = pathname || "/";
    return u.toString();
  } catch {
    return "";
  }
}

function isPaidSource(url) {
  const host = sourceHost(url);
  if (!host) return false;
  return PAID_SOURCE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function isHeavyDeprioritizedPaidSource(url) {
  const host = sourceHost(url);
  if (!host) return false;
  return HEAVY_DEPRIORITIZED_PAID_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function countWords(input) {
  return String(input || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function itemHasMinimumWords(item) {
  const summaryWords = countWords(item.summary);
  const contentWords = countWords(item.content);
  return Math.max(summaryWords, contentWords) >= MIN_ITEM_WORDS;
}

function titleFingerprint(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|and|or|for|to|of|in|on|at|from|with)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rankAndFilterItems(items, limit) {
  const ranked = items.map((item) => ({
    ...item,
    _isPaid: isPaidSource(item.url),
    _isHeavyPaid: isHeavyDeprioritizedPaidSource(item.url),
    _fp: titleFingerprint(item.title),
    _canonicalUrl: canonicalUrl(item.url),
    _source: sourceHost(item.url),
    _sortTs: String(item.sort_ts || "")
  }));

  ranked.sort((a, b) => {
    if (a._isPaid !== b._isPaid) return a._isPaid ? 1 : -1;
    if (a._isHeavyPaid !== b._isHeavyPaid) return a._isHeavyPaid ? 1 : -1;
    return b._sortTs.localeCompare(a._sortTs);
  });

  const nonPaidFingerprints = new Set(
    ranked.filter((x) => !x._isPaid && x._fp).map((x) => x._fp)
  );
  const seenTitle = new Set();
  const seenCanonicalUrl = new Set();
  const seenSourceTitle = new Set();
  const filtered = [];

  for (const item of ranked) {
    if (!itemHasMinimumWords(item)) continue;
    if (item._isPaid && item._fp && nonPaidFingerprints.has(item._fp)) continue;
    if (item._canonicalUrl && seenCanonicalUrl.has(item._canonicalUrl)) continue;
    if (item._fp && seenTitle.has(item._fp)) continue;
    const sourceTitleKey = item._fp ? `${item._fp}|${item._source}` : item.id;
    if (seenSourceTitle.has(sourceTitleKey)) continue;
    if (item._canonicalUrl) seenCanonicalUrl.add(item._canonicalUrl);
    if (item._fp) seenTitle.add(item._fp);
    seenSourceTitle.add(sourceTitleKey);
    filtered.push(item);
  }

  const nonPaid = filtered.filter((item) => !item._isPaid);
  const paid = filtered.filter((item) => item._isPaid && !item._isHeavyPaid);
  const heavyPaid = filtered.filter((item) => item._isHeavyPaid);
  const pickedNonPaid = nonPaid.slice(0, limit);
  const paidAllowance =
    pickedNonPaid.length === 0
      ? Math.min(limit, PAID_FALLBACK_WHEN_EMPTY_LIMIT)
      : Math.min(PAID_FALLBACK_LIMIT, Math.max(1, Math.floor(limit * 0.1)));
  const pickedPaid = paid.slice(0, paidAllowance);
  const heavyPaidAllowance =
    pickedNonPaid.length === 0 && pickedPaid.length === 0 ? Math.min(1, limit) : 0;
  const pickedHeavyPaid = heavyPaid.slice(0, heavyPaidAllowance);

  return [...pickedNonPaid, ...pickedPaid, ...pickedHeavyPaid]
    .slice(0, limit)
    .map(({ _isPaid, _isHeavyPaid, _fp, _canonicalUrl, _source, _sortTs, ...rest }) => rest);
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

function stripExecutableHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "")
    .replace(/<link[^>]+rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi, "")
    .replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "");
}

function tableHasColumn(db, table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => String(row?.name || "") === column);
  } catch {
    return false;
  }
}

function chunkArray(values, chunkSize) {
  const size = Math.max(1, Math.floor(Number(chunkSize) || 1));
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

function locationSet(rows) {
  return new Set(
    rows.map(
      (row) =>
        `${String(row.state_code || "").toUpperCase()}|${normalizeCounty(row.county || "")}`
    )
  );
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/health", async () => ({ ok: true, now: new Date().toISOString() }));

// ── sitemap.xml ───────────────────────────────────────────────────────────────

app.get("/sitemap.xml", async (_req, reply) => {
  const siteUrl = getSiteUrl();

  const staticRoutes = [
    { path: "/", changefreq: "daily", priority: 1.0 },
    { path: "/local", changefreq: "weekly", priority: 0.4 },
    { path: "/weather", changefreq: "weekly", priority: 0.4 },
    { path: "/lost-found", changefreq: "weekly", priority: 0.4 }
  ];

  const db = await openDb();
  let articleRows = [];
  let lostFoundRows = [];
  try {
    articleRows = db
      .prepare(
        `SELECT id, COALESCE(published_at, fetched_at) AS lastmod
         FROM items
         ORDER BY COALESCE(published_at, fetched_at) DESC
         LIMIT 500`
      )
      .all();

    lostFoundRows = db
      .prepare(
        `SELECT id, submitted_at
         FROM lost_found_posts
         WHERE status = 'approved'
           AND COALESCE(is_resolved, 0) = 0
         ORDER BY submitted_at DESC
         LIMIT 500`
      )
      .all();
  } finally {
    db.close();
  }

  const urlTags = [];

  for (const entry of staticRoutes) {
    urlTags.push(
      buildSitemapUrlTag({
        loc: `${siteUrl}${entry.path}`,
        changefreq: entry.changefreq,
        priority: entry.priority
      })
    );
  }

  for (const slug of KY_COUNTY_SLUGS) {
    urlTags.push(
      buildSitemapUrlTag({
        loc: `${siteUrl}/news/${encodeURIComponent(slug)}`,
        changefreq: "daily",
        priority: 0.8
      })
    );
  }

  for (const row of articleRows) {
    const lastmod = parseIso(row.lastmod);
    urlTags.push(
      buildSitemapUrlTag({
        loc: `${siteUrl}/item/${encodeURIComponent(String(row.id || ""))}`,
        lastmod: lastmod || undefined,
        changefreq: "monthly",
        priority: 0.6
      })
    );
  }

  for (const row of lostFoundRows) {
    const lastmod = parseIso(row.submitted_at);
    urlTags.push(
      buildSitemapUrlTag({
        loc: `${siteUrl}/lost-found?post=${encodeURIComponent(String(row.id || ""))}`,
        lastmod: lastmod || undefined,
        changefreq: "weekly",
        priority: 0.4
      })
    );
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urlTags,
    "</urlset>"
  ].join("\n");

  reply.header("content-type", "application/xml; charset=utf-8");
  return reply.send(xml);
});

// ── robots.txt ────────────────────────────────────────────────────────────────

app.get("/robots.txt", async (_req, reply) => {
  const siteUrl = getSiteUrl();
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /api/",
    `Sitemap: ${siteUrl}/sitemap.xml`
  ].join("\n");
  reply.header("content-type", "text/plain; charset=utf-8");
  return reply.send(body);
});

// ── GET /api/feeds ────────────────────────────────────────────────────────────

app.get("/api/feeds", async (req) => {
  const parsed = z
    .object({ scope: z.enum(NEWS_SCOPES).default("all") })
    .safeParse(req.query ?? {});

  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");
  const { scope } = parsed.data;

  const db = await openDb();
  try {
    const rows = db
      .prepare(
        `SELECT id, name, category, url, state_code, region_scope, enabled
         FROM feeds
         WHERE enabled=1
           AND (@scope='all' OR region_scope=@scope)
         ORDER BY CASE region_scope WHEN 'ky' THEN 0 ELSE 1 END, category, name`
      )
      .all({ scope });
    return { feeds: rows };
  } finally {
    db.close();
  }
});

// ── POST /api/feeds ───────────────────────────────────────────────────────────

const FeedBody = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url(),
  category: z.string().min(1).max(80).default("general"),
  state_code: z.string().length(2).default("KY"),
  region_scope: z.enum(["ky", "national"]).default("ky"),
  fetch_mode: z.enum(["rss", "scrape"]).default("rss"),
  default_county: z.string().max(80).optional(),
  scraper_id: z.string().max(80).optional(),
  enabled: z.boolean().default(true)
});

app.post("/api/feeds", async (req) => {
  requireAdmin(app, req);
  const parsed = FeedBody.safeParse(req.body ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");

  const data = parsed.data;
  const db = await openDb();
  try {
    const id = String(Date.now()) + Math.random().toString(36).slice(2);
    db.prepare(
      `INSERT INTO feeds (id, name, url, category, state_code, region_scope, fetch_mode, default_county, scraper_id, enabled)
       VALUES (@id, @name, @url, @category, @state_code, @region_scope, @fetch_mode, @default_county, @scraper_id, @enabled)`
    ).run({
      id,
      name: data.name,
      url: data.url,
      category: data.category,
      state_code: data.state_code.toUpperCase(),
      region_scope: data.region_scope,
      fetch_mode: data.fetch_mode,
      default_county: data.default_county || null,
      scraper_id: data.scraper_id || null,
      enabled: data.enabled ? 1 : 0
    });
    return { ok: true, id };
  } finally {
    db.close();
  }
});

// ── PUT /api/feeds/:id ────────────────────────────────────────────────────────

app.put("/api/feeds/:id", async (req) => {
  requireAdmin(app, req);
  const id = req.params?.id;
  const parsed = FeedBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");

  const data = parsed.data;
  const fields = [];
  const params = { id };

  if (data.name !== undefined) { fields.push("name=@name"); params.name = data.name; }
  if (data.url !== undefined) { fields.push("url=@url"); params.url = data.url; }
  if (data.category !== undefined) { fields.push("category=@category"); params.category = data.category; }
  if (data.state_code !== undefined) { fields.push("state_code=@state_code"); params.state_code = data.state_code.toUpperCase(); }
  if (data.region_scope !== undefined) { fields.push("region_scope=@region_scope"); params.region_scope = data.region_scope; }
  if (data.fetch_mode !== undefined) { fields.push("fetch_mode=@fetch_mode"); params.fetch_mode = data.fetch_mode; }
  if (data.default_county !== undefined) { fields.push("default_county=@default_county"); params.default_county = data.default_county || null; }
  if (data.scraper_id !== undefined) { fields.push("scraper_id=@scraper_id"); params.scraper_id = data.scraper_id || null; }
  if (data.enabled !== undefined) { fields.push("enabled=@enabled"); params.enabled = data.enabled ? 1 : 0; }

  if (!fields.length) return app.httpErrors.badRequest("No fields to update");

  const db = await openDb();
  try {
    const info = db.prepare(`UPDATE feeds SET ${fields.join(", ")} WHERE id=@id`).run(params);
    if (!info.changes) return app.httpErrors.notFound("Feed not found");
    return { ok: true, id };
  } finally {
    db.close();
  }
});

// ── DELETE /api/feeds/:id ─────────────────────────────────────────────────────

app.delete("/api/feeds/:id", async (req) => {
  requireAdmin(app, req);
  const id = req.params?.id;

  const db = await openDb();
  try {
    const info = db.prepare("DELETE FROM feeds WHERE id=?").run(id);
    if (!info.changes) return app.httpErrors.notFound("Feed not found");
    return { ok: true, id };
  } finally {
    db.close();
  }
});

// ── GET /api/items & /api/articles ───────────────────────────────────────────

const ItemsQuery = z.object({
  feedId: z.string().optional(),
  category: z.string().min(1).max(80).optional(),
  scope: z.enum(NEWS_SCOPES).default("ky"),
  state: z.string().length(2).optional(),
  county: z.string().min(1).max(80).optional(),
  counties: z.union([z.string(), z.array(z.string())]).optional(),
  unfiltered: z.string().optional(),
  hours: z.coerce.number().min(0).max(24 * 365).default(2),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30),
  tags: z.string().min(1).max(80).optional()
});

const handleItemsRoute = async (req) => {
  const parsed = ItemsQuery.safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

  const { feedId, category, scope, state, county, counties, unfiltered, hours, cursor, limit, tags } =
    parsed.data;
  const countyList = county ? [normalizeCounty(county)] : parseCountyList(counties);
  const includeUnfiltered = ["1", "true", "yes"].includes(
    String(unfiltered || "").toLowerCase()
  );

  if ((state || countyList.length) && scope === "national") {
    return app.httpErrors.badRequest("State/county filters only apply to KY scope");
  }

  const db = await openDb();
  try {
    const where = [];
    const params = { limit: includeUnfiltered ? limit : Math.min(limit * 4, 400) };

    if (hours > 0) {
      where.push("COALESCE(i.published_at, i.fetched_at) >= datetime('now', @since)");
      params.since = `-${hours} hours`;
    }

    if (scope !== "all") {
      where.push("i.region_scope = @scope");
      params.scope = scope;
    }

    if (tags) {
      where.push("(',' || COALESCE(i.tags, '') || ',') LIKE @tagsLike");
      params.tagsLike = `%,${tags},%`;
    }

    const needsFi = Boolean(feedId || category);
    if (feedId) {
      where.push("fi.feed_id = @feedId");
      params.feedId = feedId;
    }
    if (category) {
      where.push("f.category = @category");
      params.category = category;
    }

    const stateCode = (state || "KY").toUpperCase();
    const needsLoc = scope !== "national" && Boolean(state || countyList.length);

    if (needsLoc) {
      where.push("i.region_scope = 'ky'");
      params.stateCode = stateCode;
      if (countyList.length) {
        const placeholders = countyList.map((_, idx) => `@county${idx}`);
        where.push(`il.state_code = @stateCode AND il.county IN (${placeholders.join(", ")})`);
        countyList.forEach((c, idx) => {
          params[`county${idx}`] = c;
        });
      } else {
        where.push("il.state_code = @stateCode AND il.county = ''");
      }
    } else if (scope === "ky") {
      where.push(
        `EXISTS (SELECT 1 FROM item_locations ilc WHERE ilc.item_id = i.id AND ilc.state_code = 'KY' AND ilc.county = '')`
      );
    }

    const parsedCursor = parseItemsCursor(cursor);
    if (parsedCursor) {
      if (parsedCursor.id) {
        where.push(
          "(COALESCE(i.published_at, i.fetched_at) < @cursorTs OR (COALESCE(i.published_at, i.fetched_at) = @cursorTs AND i.id < @cursorId))"
        );
        params.cursorTs = parsedCursor.ts;
        params.cursorId = parsedCursor.id;
      } else {
        where.push("COALESCE(i.published_at, i.fetched_at) < @cursorTs");
        params.cursorTs = parsedCursor.ts;
      }
    }

    const whereSql = where.length ? where.join(" AND ") : "1=1";

    const sql = `
      SELECT DISTINCT
        i.id, i.title, i.url, i.author, i.region_scope, i.published_at,
        i.summary, i.content, i.image_url,
        COALESCE(i.published_at, i.fetched_at) AS sort_ts,
        (
          SELECT group_concat(DISTINCT ilx.state_code)
          FROM item_locations ilx
          WHERE ilx.item_id = i.id AND ilx.county = ''
        ) AS states_csv,
        (
          SELECT group_concat(DISTINCT ily.county)
          FROM item_locations ily
          WHERE ily.item_id = i.id AND ily.county != ''
        ) AS counties_csv
      FROM items i
      ${needsFi ? "JOIN feed_items fi ON fi.item_id = i.id" : ""}
      ${category ? "JOIN feeds f ON f.id = fi.feed_id" : ""}
      ${needsLoc ? "JOIN item_locations il ON il.item_id = i.id" : ""}
      WHERE ${whereSql}
      ORDER BY sort_ts DESC, i.id DESC
      LIMIT @limit
    `;

    const itemsRaw = db.prepare(sql).all(params);
    const mappedItems = itemsRaw.map(mapItemRow);
    const items = includeUnfiltered ? mappedItems.slice(0, limit) : rankAndFilterItems(mappedItems, limit);
    const nextCursor = items.length
      ? `${items[items.length - 1].sort_ts}|${items[items.length - 1].id}`
      : null;
    return { items, nextCursor };
  } finally {
    db.close();
  }
};

app.get("/api/items", handleItemsRoute);
app.get("/api/articles", handleItemsRoute);

// ── GET /api/counties ─────────────────────────────────────────────────────────

const CountiesQuery = z.object({
  state: z.string().length(2).default("KY"),
  hours: z.coerce.number().min(0).max(24 * 365).default(2)
});

app.get("/api/counties", async (req) => {
  const parsed = CountiesQuery.safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

  const { state, hours } = parsed.data;
  if (!isKy(state)) return app.httpErrors.badRequest("Only KY county counts are supported currently");

  const db = await openDb();
  try {
    const where = ["il.state_code = @stateCode", "il.county != ''", "i.region_scope = 'ky'"];
    const params = { stateCode: state.toUpperCase() };
    if (hours > 0) {
      where.push("COALESCE(i.published_at, i.fetched_at) >= datetime('now', @since)");
      params.since = `-${hours} hours`;
    }

    const rows = db
      .prepare(
        `SELECT il.county AS county, COUNT(DISTINCT il.item_id) AS count
         FROM item_locations il
         JOIN items i ON i.id = il.item_id
         WHERE ${where.join(" AND ")}
         GROUP BY il.county
         ORDER BY il.county`
      )
      .all(params);

    return { state: state.toUpperCase(), hours, counties: rows };
  } finally {
    db.close();
  }
});

// ── GET /api/search ───────────────────────────────────────────────────────────

const SearchQuery = z.object({
  q: z.string().min(1).max(1000),
  scope: z.enum(NEWS_SCOPES).default("ky"),
  state: z.string().length(2).optional(),
  county: z.string().min(1).max(80).optional(),
  counties: z.union([z.string(), z.array(z.string())]).optional(),
  hours: z.coerce.number().min(1).max(24 * 365).optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30)
});

app.get("/api/search", async (req) => {
  const parsed = SearchQuery.safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

  const { q, scope, state, county, counties, hours, sort, cursor, limit } = parsed.data;
  if (q.length > 800) {
    app.log.warn({ qLen: q.length }, "search q exceeds 800 chars; consider shortening the query");
  }
  const countyList = county ? [normalizeCounty(county)] : parseCountyList(counties);

  if ((state || countyList.length) && scope === "national") {
    return app.httpErrors.badRequest("State/county filters only apply to KY scope");
  }

  const db = await openDb();
  try {
    const where = [];
    const params = { limit: Math.min(limit * 4, 400) };

    const searchClause = buildSearchClause(q, params);
    const hintedCounties =
      scope === "national"
        ? []
        : Array.from(
            new Set(
              detectKyQueryCounties(q)
                .map((x) => normalizeCounty(x))
                .filter(Boolean)
            )
          );

    if (hintedCounties.length) {
      const hintPlaceholders = hintedCounties.map((_, idx) => `@hintCounty${idx}`);
      where.push(`(${searchClause} OR EXISTS (
        SELECT 1
        FROM item_locations ilh
        WHERE ilh.item_id = i.id
          AND ilh.state_code = 'KY'
          AND ilh.county IN (${hintPlaceholders.join(", ")})
      ))`);
      hintedCounties.forEach((countyName, idx) => {
        params[`hintCounty${idx}`] = countyName;
      });
    } else {
      where.push(searchClause);
    }

    if (hours != null) {
      where.push("COALESCE(i.published_at, i.fetched_at) >= datetime('now', @since)");
      params.since = `-${hours} hours`;
    }

    if (scope !== "all") {
      where.push("i.region_scope = @scope");
      params.scope = scope;
    }

    const needsLoc = scope !== "national" && Boolean(state || countyList.length);
    if (needsLoc) {
      params.stateCode = (state || "KY").toUpperCase();
      where.push("i.region_scope = 'ky'");
      if (countyList.length) {
        const placeholders = countyList.map((_, idx) => `@county${idx}`);
        where.push(`il.state_code = @stateCode AND il.county IN (${placeholders.join(", ")})`);
        countyList.forEach((c, idx) => {
          params[`county${idx}`] = c;
        });
      } else {
        where.push("il.state_code = @stateCode AND il.county = ''");
      }
    }

    if (cursor) {
      where.push(
        `COALESCE(i.published_at, i.fetched_at) ${sort === "oldest" ? ">" : "<"} @cursor`
      );
      params.cursor = cursor;
    }

    const sql = `
      SELECT DISTINCT
        i.id, i.title, i.url, i.author, i.region_scope, i.published_at,
        i.summary, i.content, i.image_url,
        COALESCE(i.published_at, i.fetched_at) AS sort_ts,
        (
          SELECT group_concat(DISTINCT ilx.state_code)
          FROM item_locations ilx
          WHERE ilx.item_id = i.id AND ilx.county = ''
        ) AS states_csv,
        (
          SELECT group_concat(DISTINCT ily.county)
          FROM item_locations ily
          WHERE ily.item_id = i.id AND ily.county != ''
        ) AS counties_csv
      FROM items i
      ${needsLoc ? "JOIN item_locations il ON il.item_id = i.id" : ""}
      WHERE ${where.join(" AND ")}
      ORDER BY sort_ts ${sort === "oldest" ? "ASC" : "DESC"}
      LIMIT @limit
    `;

    const itemsRaw = db.prepare(sql).all(params);
    const items = rankAndFilterItems(itemsRaw.map(mapItemRow), limit);
    const nextCursor = items.length ? items[items.length - 1].sort_ts : null;

    return { items, nextCursor };
  } finally {
    db.close();
  }
});

// ── GET /api/items/:id ────────────────────────────────────────────────────────

app.get("/api/items/:id", async (req) => {
  const id = req.params?.id;
  const db = await openDb();
  try {
    const itemRaw = db
      .prepare(
        `SELECT id, title, url, author, region_scope, published_at, summary, content, image_url,
          (SELECT group_concat(DISTINCT state_code) FROM item_locations WHERE item_id=items.id AND county='') AS states_csv,
          (SELECT group_concat(DISTINCT county) FROM item_locations WHERE item_id=items.id AND county!='') AS counties_csv
         FROM items WHERE id=?`
      )
      .get(id);

    if (!itemRaw) return app.httpErrors.notFound("Not found");
    return { item: mapItemRow(itemRaw) };
  } finally {
    db.close();
  }
});

// ── GET /api/stats ────────────────────────────────────────────────────────────

app.get("/api/stats", async (_req) => {
  const db = await openDb();
  try {
    const itemCount = db.prepare("SELECT COUNT(1) AS n FROM items").get()?.n ?? 0;
    const feedCount = db.prepare("SELECT COUNT(1) AS n FROM feeds WHERE enabled=1").get()?.n ?? 0;
    const kyCount = db
      .prepare("SELECT COUNT(1) AS n FROM items WHERE region_scope='ky'")
      .get()?.n ?? 0;
    const last24h = db
      .prepare(
        "SELECT COUNT(1) AS n FROM items WHERE COALESCE(published_at, fetched_at) >= datetime('now', '-24 hours')"
      )
      .get()?.n ?? 0;

    return {
      items: { total: itemCount, ky: kyCount, last24h },
      feeds: { enabled: feedCount }
    };
  } finally {
    db.close();
  }
});

// ── GET /api/open-proxy ───────────────────────────────────────────────────────

const OpenProxyQuery = z.object({ url: z.string().url() });

app.get("/api/open-proxy", async (req) => {
  const parsed = OpenProxyQuery.safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid URL");

  let target;
  try {
    target = new URL(parsed.data.url);
  } catch {
    return app.httpErrors.badRequest("Invalid URL");
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    return app.httpErrors.badRequest("Only HTTP(S) URLs are allowed");
  }
  if (isPrivateHost(target.hostname)) {
    return app.httpErrors.badRequest("Private/local hosts are not allowed");
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(target.toString(), {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; KentuckyNewsApp/1.0)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!upstream.ok) {
      return app.httpErrors.badGateway(`Upstream returned ${upstream.status}`);
    }

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return app.httpErrors.unsupportedMediaType("Upstream content is not HTML");
    }

    const finalUrl = upstream.url || target.toString();
    let html = await upstream.text();
    if (html.length > 1_500_000) html = html.slice(0, 1_500_000);

    const safeHtml = stripExecutableHtml(html);
    const titleMatch = safeHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

    const framedHtml = [
      "<!doctype html><html><head>",
      `<base href="${finalUrl.replace(/"/g, "&quot;")}">`,
      '<meta charset="utf-8"/>',
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
      "<style>html,body{margin:0;padding:0;background:#fff;color:#111;font-family:Roboto,Arial,sans-serif}img,video,iframe{max-width:100%;height:auto}body{padding:10px}</style>",
      "</head><body>",
      safeHtml,
      "</body></html>"
    ].join("");

    return { url: target.toString(), finalUrl, title, html: framedHtml };
  } catch (err) {
    return app.httpErrors.badGateway(String(err?.message || err));
  } finally {
    clearTimeout(timeout);
  }
});

// ── POST /api/ingest ──────────────────────────────────────────────────────────

async function runIngestOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ingesterScript, "--once"], {
      cwd: repoRoot,
      env: { ...process.env, INGEST_ONCE: "1" }
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 180000);

    child.stdout.on("data", (buf) => {
      stdout += String(buf);
      if (stdout.length > 12000) stdout = stdout.slice(-12000);
    });
    child.stderr.on("data", (buf) => {
      stderr += String(buf);
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

app.post("/api/ingest", async (req) => {
  requireAdmin(app, req);
  const run = await runIngestOnce();
  return {
    ok: Number(run.code) === 0,
    code: run.code,
    stdout: run.stdout,
    stderr: run.stderr
  };
});

// ── POST /api/admin/feeds/reload ──────────────────────────────────────────────

app.post("/api/admin/feeds/reload", async (req) => {
  const admin = requireAdmin(app, req);
  const run = await runIngestOnce();
  const ok = Number(run.code) === 0;

  const db = await openDb();
  try {
    insertAdminLog(db, admin.email, "feeds.reload", "ingester", "manual", {
      code: run.code,
      stderr: run.stderr.slice(-500)
    });
  } finally {
    db.close();
  }

  if (!ok) {
    return app.httpErrors.internalServerError(
      JSON.stringify({ ok: false, code: run.code, stderr: run.stderr, stdout: run.stdout })
    );
  }

  return { ok: true, code: run.code, stdout: run.stdout, stderr: run.stderr };
});

// ── POST /api/admin/items/revalidate ──────────────────────────────────────────

const RevalidateItemsBody = z.object({
  hours: z.coerce.number().min(1).max(24 * 90).default(72),
  limit: z.coerce.number().min(1).max(3000).default(800),
  minWords: z.coerce.number().min(1).max(1000).default(50),
  dryRun: z.boolean().default(true),
  includeNational: z.boolean().default(false)
});

app.post("/api/admin/items/revalidate", async (req) => {
  const admin = requireAdmin(app, req);
  const parsed = RevalidateItemsBody.safeParse(req.body ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");

  const options = parsed.data;
  const db = await openDb();
  try {
    const hasArticleExcerpt = tableHasColumn(db, "items", "article_text_excerpt");
    const hasRegionScope = tableHasColumn(db, "items", "region_scope");
    const excerptSelect = hasArticleExcerpt
      ? "i.article_text_excerpt AS article_text_excerpt"
      : "'' AS article_text_excerpt";
    const scopeWhere = options.includeNational || !hasRegionScope ? "" : "AND i.region_scope='ky'";

    const rows = db
      .prepare(
        `SELECT i.id, i.title, i.summary, i.content, ${excerptSelect}
         FROM items i
         WHERE COALESCE(i.published_at, i.fetched_at) >= datetime('now', @window)
           ${scopeWhere}
         ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
         LIMIT @limit`
      )
      .all({ window: `-${options.hours} hours`, limit: options.limit });

    const summary = {
      scanned: rows.length,
      dryRun: options.dryRun,
      hours: options.hours,
      limit: options.limit,
      minWords: options.minWords,
      includeNational: options.includeNational,
      unchanged: 0,
      wouldRetag: 0,
      retagged: 0,
      wouldPrune: 0,
      pruned: 0,
      prunedFeedLinks: 0,
      samples: []
    };

    if (!rows.length) {
      insertAdminLog(db, admin.email, "items.revalidate", "items", "batch", summary);
      return { ok: true, summary };
    }

    const ids = rows.map((r) => String(r.id || "")).filter(Boolean);
    const tags = [];
    for (const batch of chunkArray(ids, 200)) {
      if (!batch.length) continue;
      const partial = db
        .prepare(
          `SELECT item_id, state_code, county
           FROM item_locations
           WHERE item_id IN (${batch.map(() => "?").join(",")})`
        )
        .all(...batch);
      tags.push(...partial);
    }

    const tagsByItem = new Map();
    for (const row of tags) {
      const id = String(row.item_id || "");
      if (!id) continue;
      const list = tagsByItem.get(id) || [];
      list.push({
        state_code: String(row.state_code || "").toUpperCase(),
        county: normalizeCounty(row.county || "")
      });
      tagsByItem.set(id, list);
    }

    const countFeedRefsStmt = db.prepare("SELECT COUNT(1) AS refs FROM feed_items WHERE item_id=?");
    const delFeedRefsStmt = db.prepare("DELETE FROM feed_items WHERE item_id=?");
    const delTagsStmt = db.prepare("DELETE FROM item_locations WHERE item_id=?");
    const delItemStmt = db.prepare("DELETE FROM items WHERE id=?");
    const delKyTagsStmt = db.prepare(
      "DELETE FROM item_locations WHERE item_id=? AND state_code='KY'"
    );
    const insStateStmt = db.prepare(
      "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, 'KY', '')"
    );
    const insCountyStmt = db.prepare(
      "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, 'KY', ?)"
    );

    for (const row of rows) {
      const itemId = String(row.id || "");
      if (!itemId) continue;

      const title = String(row.title || "");
      const summaryText = String(row.summary || "");
      const content = String(row.content || "");
      const excerpt = String(row.article_text_excerpt || "");
      const articleText = excerpt || content || "";
      const qualityText = articleText || summaryText || "";
      const words = countWords(qualityText);

      if (words < options.minWords) {
        summary.wouldPrune += 1;
        if (summary.samples.length < 20) {
          summary.samples.push({ item_id: itemId, action: "prune", words, title });
        }
        if (!options.dryRun) {
          const refs = countFeedRefsStmt.get(itemId);
          delFeedRefsStmt.run(itemId);
          delTagsStmt.run(itemId);
          delItemStmt.run(itemId);
          summary.pruned += 1;
          summary.prunedFeedLinks += Number(refs?.refs || 0);
        }
        continue;
      }

      const fullText = articleText;
      const titleCounties = detectKyCounties(title);
      const bodyCounties = detectKyCounties(fullText);
      const taggedCounties = new Set(
        [...titleCounties, ...bodyCounties].map((x) => normalizeCounty(x)).filter(Boolean)
      );
      const titleKySignal = hasKySignal(title, titleCounties);
      const bodyKySignal = hasKySignal(fullText, bodyCounties);
      const hasStrongKySignal = titleKySignal || bodyKySignal || taggedCounties.size > 0;
      const titleOtherStates = detectOtherStateNames(title);
      const bodyOtherStates = detectOtherStateNames(fullText);
      const hasTitleOutOfStateSignal =
        titleOtherStates.length > 0 && !titleKySignal && titleCounties.length === 0;
      const hasPrimaryOutOfStateSignal =
        bodyOtherStates.length > 0 && !bodyKySignal && bodyCounties.length === 0;
      const shouldTagAsKy =
        hasStrongKySignal && !hasTitleOutOfStateSignal && !hasPrimaryOutOfStateSignal;

      const existing = tagsByItem.get(itemId) || [];
      const nonKy = existing.filter((t) => t.state_code !== "KY");
      const desired = [...nonKy];
      if (shouldTagAsKy) {
        desired.push({ state_code: "KY", county: "" });
        for (const county of Array.from(taggedCounties).sort((a, b) => a.localeCompare(b))) {
          desired.push({ state_code: "KY", county });
        }
      }

      const currentSet = locationSet(existing);
      const desiredSet = locationSet(desired);
      if (sameSet(currentSet, desiredSet)) {
        summary.unchanged += 1;
        continue;
      }

      summary.wouldRetag += 1;
      if (summary.samples.length < 20) {
        summary.samples.push({
          item_id: itemId,
          action: "retag",
          title,
          counties: Array.from(taggedCounties).sort((a, b) => a.localeCompare(b)),
          should_tag_ky: shouldTagAsKy
        });
      }

      if (!options.dryRun) {
        delKyTagsStmt.run(itemId);
        if (shouldTagAsKy) {
          insStateStmt.run(itemId);
          for (const county of Array.from(taggedCounties)) {
            insCountyStmt.run(itemId, county);
          }
        }

        const computedTags = computeContentTags({
          title,
          summary: summaryText,
          content: articleText,
          url: String(
            db.prepare("SELECT url FROM items WHERE id=?").get(itemId)?.url || ""
          )
        });
        db.prepare("UPDATE items SET tags=? WHERE id=?").run(computedTags, itemId);
        summary.retagged += 1;
      }
    }

    insertAdminLog(db, admin.email, "items.revalidate", "items", "batch", summary);
    return { ok: true, summary };
  } finally {
    db.close();
  }
});

// ── GET /api/admin/audit-log ──────────────────────────────────────────────────

app.get("/api/admin/audit-log", async (req) => {
  requireAdmin(app, req);
  const parsed = z
    .object({ limit: z.coerce.number().min(1).max(500).default(100) })
    .safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

  const db = await openDb();
  try {
    const rows = db
      .prepare(
        `SELECT id, actor_email, action, entity_type, entity_id, payload_json, created_at
         FROM admin_audit_log
         ORDER BY created_at DESC
         LIMIT @limit`
      )
      .all({ limit: parsed.data.limit });

    return {
      logs: rows.map((r) => ({
        ...r,
        payload: r.payload_json ? (() => { try { return JSON.parse(r.payload_json); } catch { return null; } })() : null
      }))
    };
  } finally {
    db.close();
  }
});

// ── GET /api/admin/feeds (feed management with metrics) ──────────────────────

app.get("/api/admin/feeds", async (req) => {
  requireAdmin(app, req);
  const parsed = z
    .object({
      scope: z.enum(["all", "ky", "national"]).default("all"),
      enabled: z.enum(["all", "1", "0"]).default("all")
    })
    .safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

  const { scope, enabled } = parsed.data;
  const db = await openDb();
  try {
    const where = [];
    const params = {};
    if (scope !== "all") { where.push("f.region_scope=@scope"); params.scope = scope; }
    if (enabled !== "all") { where.push("f.enabled=@enabled"); params.enabled = Number(enabled); }

    const feeds = db
      .prepare(
        `SELECT f.id, f.name, f.url, f.category, f.state_code, f.region_scope,
                f.enabled, f.fetch_mode, f.default_county, f.scraper_id
         FROM feeds f
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY f.region_scope, f.category, f.name`
      )
      .all(params);

    return { feeds };
  } finally {
    db.close();
  }
});

// ── GET /api/admin/items ──────────────────────────────────────────────────────

app.get("/api/admin/items", async (req) => {
  requireAdmin(app, req);
  const parsed = z
    .object({
      limit: z.coerce.number().min(1).max(500).default(100),
      scope: z.enum(["all", "ky", "national"]).default("all"),
      hours: z.coerce.number().min(0).max(24 * 365).default(24)
    })
    .safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

  const { limit, scope, hours } = parsed.data;
  const db = await openDb();
  try {
    const where = [];
    const params = { limit };
    if (scope !== "all") { where.push("region_scope=@scope"); params.scope = scope; }
    if (hours > 0) {
      where.push("COALESCE(published_at, fetched_at) >= datetime('now', @since)");
      params.since = `-${hours} hours`;
    }

    const rows = db
      .prepare(
        `SELECT id, title, url, region_scope, published_at, fetched_at, tags
         FROM items
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY COALESCE(published_at, fetched_at) DESC
         LIMIT @limit`
      )
      .all(params);

    return { items: rows };
  } finally {
    db.close();
  }
});

// ── GET /api/admin/coverage ───────────────────────────────────────────────────

app.get("/api/admin/coverage", async (req) => {
  requireAdmin(app, req);
  const db = await openDb();
  try {
    const rows = db
      .prepare(
        `SELECT il.county,
                COUNT(DISTINCT i.id)  AS article_count,
                MAX(i.published_at)   AS latest_article
         FROM item_locations il
         JOIN items i ON i.id = il.item_id
         WHERE il.state_code = 'KY'
           AND il.county != ''
           AND i.published_at >= datetime('now', '-7 days')
         GROUP BY il.county
         ORDER BY article_count DESC`
      )
      .all();
    return { coverage: rows };
  } finally {
    db.close();
  }
});

// ── Legacy /api/admin/* catch-all for backward compat ────────────────────────
// Any admin route not explicitly defined returns 404 with a helpful message.

// ─────────────────────────────────────────────────────────────────────────────
// Sub-module routes (weather, lost-found, SEO)
// ─────────────────────────────────────────────────────────────────────────────
// These modules call openDb() synchronously (legacy pattern).
// We supply syncOpenDb which returns a raw better-sqlite3 instance.
// All schema operations inside these modules use the native better-sqlite3 API
// which is identical in interface to what they expect.

registerWeatherRoutes(app, syncOpenDb);
registerLostFoundRoutes(app, syncOpenDb, uploadDir);
registerSeoRoutes(app, syncOpenDb);

// ─────────────────────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

app.listen({ port, host }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`New Backend server listening at ${address}`);
});
