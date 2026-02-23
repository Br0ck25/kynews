#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { XMLParser } from "fast-xml-parser";
import kyCounties from "../src/data/ky-counties.json" with { type: "json" };
import kyCityCounty from "../src/data/ky-city-county.json" with { type: "json" };

const DEFAULT_DB_NAME = "ky-news-db";
const DEFAULT_LIMIT = 2000;
const DEFAULT_FEED_TIMEOUT_MS = 15_000;
const DEFAULT_ARTICLE_TIMEOUT_MS = 12_000;
const DEFAULT_ARTICLE_MAX_CHARS = 2_000_000;
const DEFAULT_ARTICLE_EXCERPT_MAX_CHARS = 10_000;
const DEFAULT_FEED_CACHE_ITEMS = 300;
const DEFAULT_PROGRESS_EVERY = 25;

const AMBIGUOUS_CITY_TERMS = ["Lexington", "Louisville", "Georgetown", "Franklin", "Winchester"];
const KY_CITY_REGION_TERMS = [
  "Lexington",
  "Louisville",
  "Frankfort",
  "Bowling Green",
  "Owensboro",
  "Covington",
  "Pikeville",
  "Paducah",
  "Ashland",
  "Elizabethtown",
  "Hopkinsville",
  "Richmond",
  "Florence",
  "Georgetown",
  "Nicholasville",
  "Jeffersontown",
  "Radcliff",
  "Madisonville",
  "Winchester",
  "Erlanger",
  "Franklin",
  "Eastern Kentucky",
  "Western Kentucky",
  "Central Kentucky",
  "Appalachian Kentucky"
];
const EXPLICIT_KY_TERMS = ["Kentucky", "KY"];
const AMBIGUOUS_SET = new Set(AMBIGUOUS_CITY_TERMS.map((term) => term.toLowerCase()));
const NON_AMBIGUOUS_TERMS = KY_CITY_REGION_TERMS.filter((term) => !AMBIGUOUS_SET.has(term.toLowerCase()));

const COUNTY_NAME_BY_NORMALIZED = new Map(
  (Array.isArray(kyCounties) ? kyCounties : [])
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean)
    .map((name) => [
      name.toLowerCase().replace(/\s+county$/i, "").replace(/[^a-z0-9]+/g, " ").trim(),
      name
    ])
);

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/backfill-ky-relevance.mjs [options]",
      "",
      "Options:",
      "  --database <name>         D1 database name (default: ky-news-db)",
      "  --local                   Use local D1 database (default)",
      "  --remote                  Use remote D1 database",
      "  --apply                   Apply changes (default is dry run)",
      "  --dry-run                 Force dry-run mode",
      "  --limit <n>               Number of items to scan (default: 2000)",
      "  --feed-cache-items <n>    Max entries cached per feed fetch (default: 300)",
      "  --progress-every <n>      Log progress every N items (default: 25)",
      "  --help                    Show this help message"
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = {
    database: DEFAULT_DB_NAME,
    remote: false,
    dryRun: true,
    limit: DEFAULT_LIMIT,
    feedCacheItems: DEFAULT_FEED_CACHE_ITEMS,
    progressEvery: DEFAULT_PROGRESS_EVERY
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--database") {
      args.database = String(argv[i + 1] || "").trim() || DEFAULT_DB_NAME;
      i += 1;
      continue;
    }
    if (arg === "--remote") {
      args.remote = true;
      continue;
    }
    if (arg === "--local") {
      args.remote = false;
      continue;
    }
    if (arg === "--apply") {
      args.dryRun = false;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[i + 1] || "");
      if (Number.isFinite(value) && value > 0) args.limit = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--feed-cache-items") {
      const value = Number(argv[i + 1] || "");
      if (Number.isFinite(value) && value > 0) args.feedCacheItems = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--progress-every") {
      const value = Number(argv[i + 1] || "");
      if (Number.isFinite(value) && value > 0) args.progressEvery = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
  }

  return args;
}

function bumpCounter(obj, key) {
  const safeKey = String(key || "unknown");
  obj[safeKey] = Number(obj[safeKey] || 0) + 1;
}

function classifyErrorReason(err) {
  const msg = String(err instanceof Error ? err.message : err || "")
    .toLowerCase()
    .trim();
  if (!msg) return "unknown";
  if (msg.includes("wrangler d1 execute failed")) return "d1_execute_failed";
  if (msg.includes("required tables are missing")) return "missing_tables";
  if (msg.includes("json")) return "json_parse_error";
  if (msg.includes("fetch")) return "fetch_failed";
  if (msg.includes("timeout")) return "timeout";
  if (msg.includes("readability")) return "readability_error";
  return "unknown";
}

function escapeSql(value) {
  return String(value || "").replace(/'/g, "''");
}

function q(value) {
  if (value == null) return "NULL";
  return `'${escapeSql(value)}'`;
}

function parseWranglerJsonPayload(outputText) {
  const text = String(outputText || "").trim();
  if (!text) return [];

  try {
    return JSON.parse(text);
  } catch {
    // Wrangler can print progress lines before JSON (especially with --file).
  }

  let idx = text.indexOf("[");
  while (idx !== -1) {
    const candidate = text.slice(idx).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      idx = text.indexOf("[", idx + 1);
    }
  }

  throw new Error(`Unexpected Wrangler JSON output: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
}

function runWranglerD1({ database, remote, sql, useFile = false }) {
  const wranglerEntrypoint = path.join(
    process.cwd(),
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js"
  );
  const args = ["d1", "execute", database, remote ? "--remote" : "--local", "--json"];

  let tempDir = "";
  if (useFile) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ky-news-worker-d1-"));
    const sqlFile = path.join(tempDir, "query.sql");
    fs.writeFileSync(sqlFile, `${String(sql || "").trim()}\n`, "utf8");
    args.push("--file", sqlFile);
  } else {
    args.push("--command", String(sql || ""));
  }

  const out = spawnSync(process.execPath, [wranglerEntrypoint, ...args], {
    cwd: path.resolve(process.cwd()),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32
  });

  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  if (out.status !== 0) {
    const stderr = String(out.stderr || "").trim();
    const stdout = String(out.stdout || "").trim();
    throw new Error(
      [
        `wrangler d1 execute failed (exit ${out.status || 1})`,
        out.error?.message || "",
        stderr,
        stdout
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  const parsed = parseWranglerJsonPayload(String(out.stdout || out.stderr || "[]"));
  if (!Array.isArray(parsed) || !parsed.length) return [];
  const first = parsed[0];
  if (!first?.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(first, null, 2)}`);
  }
  return Array.isArray(first.results) ? first.results : [];
}

async function d1Select(config, sql) {
  return runWranglerD1({ ...config, sql, useFile: false });
}

async function d1Execute(config, sql) {
  runWranglerD1({ ...config, sql, useFile: true });
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
    const nextPath = u.pathname.replace(/\/+$/, "");
    u.pathname = nextPath || "/";
    return u.toString();
  } catch {
    return String(url || "");
  }
}

function textOnly(input) {
  return String(input || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term) {
  return `\\b${escapeRegex(term).replace(/\s+/g, "\\s+")}\\b`;
}

function combinedRegex(terms) {
  if (!terms.length) return null;
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  return new RegExp(`(?:${sorted.map(termPattern).join("|")})`, "gi");
}

const TITLE_EXPLICIT_KY_RE = combinedRegex(EXPLICIT_KY_TERMS);
const TITLE_NON_AMBIGUOUS_RE = combinedRegex(NON_AMBIGUOUS_TERMS);
const TITLE_AMBIGUOUS_RE = combinedRegex(AMBIGUOUS_CITY_TERMS);
const BODY_BASE_TERMS_RE = combinedRegex([...EXPLICIT_KY_TERMS, ...NON_AMBIGUOUS_TERMS]);
const BODY_WITH_AMBIGUOUS_TERMS_RE = combinedRegex([...EXPLICIT_KY_TERMS, ...NON_AMBIGUOUS_TERMS, ...AMBIGUOUS_CITY_TERMS]);
const ANY_AMBIGUOUS_RE = combinedRegex(AMBIGUOUS_CITY_TERMS);

function hasMatch(input, re) {
  if (!re) return false;
  re.lastIndex = 0;
  return re.test(input);
}

function countMentions(input, re) {
  if (!re) return 0;
  re.lastIndex = 0;
  const matches = String(input || "").match(re);
  return matches ? matches.length : 0;
}

function isKentuckyRelevant(title, bodyText) {
  const titleText = String(title || "");
  const body = String(bodyText || "");
  const articleText = `${titleText}\n${body}`;

  const hasArticleKySignal = hasMatch(articleText, TITLE_EXPLICIT_KY_RE);
  const titleHasExplicitKy = hasMatch(titleText, TITLE_EXPLICIT_KY_RE);
  const titleHasUnambiguousTerm = hasMatch(titleText, TITLE_NON_AMBIGUOUS_RE);
  const titleHasAmbiguousTerm = hasMatch(titleText, TITLE_AMBIGUOUS_RE);

  const titleStrongMatch =
    titleHasExplicitKy ||
    titleHasUnambiguousTerm ||
    (titleHasAmbiguousTerm && hasArticleKySignal);

  if (titleStrongMatch) {
    return { relevant: true, matchedTier: "tier1_title", failedTier: null, bodyMentions: 0 };
  }

  const bodyMentions = countMentions(body, hasArticleKySignal ? BODY_WITH_AMBIGUOUS_TERMS_RE : BODY_BASE_TERMS_RE);
  if (bodyMentions >= 2) {
    return { relevant: true, matchedTier: "tier2_body", failedTier: null, bodyMentions };
  }

  const hasAmbiguousWithoutKy = !hasArticleKySignal && hasMatch(articleText, ANY_AMBIGUOUS_RE);
  return {
    relevant: false,
    matchedTier: null,
    failedTier: hasAmbiguousWithoutKy ? "tier3_ambiguous_city" : "tier2_body",
    bodyMentions
  };
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCounty(county) {
  const base = String(county || "")
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+county$/i, "")
    .trim();
  if (!base) return "";
  const key = base.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return COUNTY_NAME_BY_NORMALIZED.get(key) || base;
}

const KY_COUNTY_PATTERNS = (() => {
  const names = (Array.isArray(kyCounties) ? kyCounties : []).map((c) => c.name).filter(Boolean);
  names.sort((a, b) => b.length - a.length);
  return names.map((name) => {
    const n = norm(name);
    const re = new RegExp(`\\b${n.replace(/\s+/g, "\\s+")}\\s+(county|co\\.?)(\\b|\\s|,|\\.)`, "i");
    return { name, re };
  });
})();

const KY_CITY_PATTERNS = (() => {
  const rows = Array.isArray(kyCityCounty) ? kyCityCounty : [];
  const cities = rows
    .map((r) => ({ city: String(r.city || "").trim(), county: String(r.county || "").trim() }))
    .filter((r) => r.city && r.county);
  cities.sort((a, b) => b.city.length - a.city.length);
  return cities.map(({ city, county }) => {
    const n = norm(city);
    const re = new RegExp(`\\b${n.replace(/\s+/g, "\\s+")}\\b`, "i");
    return { city, county, re };
  });
})();

function detectKyCounties(text) {
  const t = norm(text);
  if (!t) return [];

  const out = [];
  const raw = String(text || "");
  const hasKyContext = /\bkentucky\b/i.test(raw) || /\bky\b/i.test(raw);

  for (const { name, re } of KY_COUNTY_PATTERNS) {
    if (re.test(t)) out.push(name);
  }

  if (hasKyContext) {
    for (const { county, re } of KY_CITY_PATTERNS) {
      if (re.test(t)) out.push(county);
    }
  }

  return Array.from(new Set(out));
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  removeNSPrefix: false
});

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const obj = value;
    if (typeof obj["#text"] === "string") return obj["#text"];
    if (typeof obj.__cdata === "string") return obj.__cdata;
    if (typeof obj.href === "string") return obj.href;
    if (typeof obj.url === "string") return obj.url;
  }
  return "";
}

function pickLink(link) {
  if (!link) return "";
  if (typeof link === "string") return link;
  if (Array.isArray(link)) {
    const alt = link.find((x) => String(x?.rel || "alternate") === "alternate");
    const candidate = alt || link[0];
    if (candidate && typeof candidate === "object") {
      return textOf(candidate.href || candidate.url || candidate["#text"] || "");
    }
    return textOf(candidate);
  }
  if (typeof link === "object") {
    return textOf(link.href || link.url || link["#text"] || "");
  }
  return "";
}

function parseFeedItems(xml) {
  const doc = xmlParser.parse(xml);
  const out = [];

  const rssItems = toArray(doc?.rss?.channel?.item);
  for (const item of rssItems) {
    out.push({
      title: textOnly(textOf(item.title) || "(untitled)"),
      link: canonicalUrl(pickLink(item.link || item.guid)),
      guid: canonicalUrl(textOf(item.guid)),
      description: textOnly(textOf(item.description || item.summary || item.contentSnippet || item["content:encoded"] || ""))
    });
  }

  const atomEntries = toArray(doc?.feed?.entry);
  for (const entry of atomEntries) {
    out.push({
      title: textOnly(textOf(entry.title) || "(untitled)"),
      link: canonicalUrl(pickLink(entry.link || entry.id)),
      guid: canonicalUrl(textOf(entry.id)),
      description: textOnly(textOf(entry.summary || entry.content || ""))
    });
  }

  return out;
}

async function fetchText(url, timeoutMs, accept, userAgent) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        accept,
        "user-agent": userAgent
      }
    });
    if (!res.ok) return { ok: false, status: res.status, text: "", contentType: "" };
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    return { ok: true, status: res.status, text, contentType };
  } catch {
    return { ok: false, status: 0, text: "", contentType: "" };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildFeedIndex(feedUrl, maxItems) {
  if (!feedUrl) return { index: new Map(), errorReason: "missing_feed_url" };
  const result = await fetchText(
    feedUrl,
    DEFAULT_FEED_TIMEOUT_MS,
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
    "EKY-News-Backfill/1.0 (+https://localkynews.com)"
  );
  if (!result.ok || !result.text) return { index: new Map(), errorReason: "feed_fetch_failed" };

  let entries = [];
  try {
    entries = parseFeedItems(result.text).slice(0, maxItems);
  } catch {
    return { index: new Map(), errorReason: "feed_parse_failed" };
  }
  const byCanonical = new Map();
  for (const entry of entries) {
    if (entry.link) byCanonical.set(entry.link, entry);
    if (entry.guid && !byCanonical.has(entry.guid)) byCanonical.set(entry.guid, entry);
  }
  return { index: byCanonical, errorReason: null };
}

async function fetchReadableArticleText(url) {
  if (!url || !/^https?:\/\//i.test(url)) return { text: "", errorReason: "invalid_url" };
  const fetched = await fetchText(
    url,
    DEFAULT_ARTICLE_TIMEOUT_MS,
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Mozilla/5.0 (compatible; EKY-News-Backfill/1.0)"
  );
  if (!fetched.ok || !fetched.text) return { text: "", errorReason: "article_fetch_failed" };
  if (!fetched.contentType.includes("text/html") && !fetched.contentType.includes("application/xhtml")) {
    return { text: "", errorReason: "article_non_html" };
  }

  try {
    let html = fetched.text;
    if (html.length > DEFAULT_ARTICLE_MAX_CHARS) html = html.slice(0, DEFAULT_ARTICLE_MAX_CHARS);
    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();
    const cleanText = textOnly([article?.title, article?.textContent].filter(Boolean).join(" "));
    if (!cleanText) return { text: "", errorReason: "readability_empty" };
    return {
      text:
        cleanText.length > DEFAULT_ARTICLE_EXCERPT_MAX_CHARS
          ? cleanText.slice(0, DEFAULT_ARTICLE_EXCERPT_MAX_CHARS)
          : cleanText,
      errorReason: null
    };
  } catch {
    return { text: "", errorReason: "readability_parse_failed" };
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const wranglerConfig = {
    database: options.database,
    remote: options.remote
  };

  console.log(
    [
      "[backfill-ky-relevance] starting",
      `mode=${options.remote ? "remote" : "local"}`,
      `dryRun=${options.dryRun ? "true" : "false"}`,
      `database=${options.database}`,
      `limit=${options.limit}`
    ].join(" ")
  );

  const tableCheck = await d1Select(
    wranglerConfig,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('items','item_locations','feed_items','feeds');"
  );
  const tables = new Set(tableCheck.map((r) => String(r.name || "").trim()).filter(Boolean));
  const missing = ["items", "item_locations", "feed_items", "feeds"].filter((name) => !tables.has(name));
  if (missing.length) {
    throw new Error(
      `Required tables are missing: ${missing.join(", ")}. Run migrations first or use --remote against the deployed D1 database.`
    );
  }

  const rows = await d1Select(
    wranglerConfig,
    `
    SELECT
      i.id,
      i.title,
      i.url,
      i.summary,
      i.content,
      i.article_text_excerpt,
      MIN(f.url) AS feed_url,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM feed_items fi2
          JOIN feeds f2 ON f2.id = fi2.feed_id
          WHERE fi2.item_id = i.id
            AND COALESCE(f2.region_scope, 'ky') != 'ky'
        ) THEN 1 ELSE 0
      END AS has_non_ky_refs
    FROM items i
    JOIN feed_items fi ON fi.item_id = i.id
    JOIN feeds f ON f.id = fi.feed_id
    WHERE i.region_scope='ky' AND COALESCE(f.region_scope, 'ky')='ky'
    GROUP BY i.id
    ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.id DESC
    LIMIT ${Math.max(1, Math.floor(options.limit))}
    `
  );

  const items = rows
    .map((row) => ({
      id: String(row.id || ""),
      title: String(row.title || ""),
      url: canonicalUrl(String(row.url || "")),
      summary: String(row.summary || ""),
      content: String(row.content || ""),
      articleTextExcerpt: String(row.article_text_excerpt || ""),
      feedUrl: String(row.feed_url || ""),
      hasNonKyRefs: Number(row.has_non_ky_refs || 0) > 0
    }))
    .filter((row) => row.id);
  console.log(`[backfill-ky-relevance] loaded ${items.length} unique KY-scope items`);

  const feedCache = new Map();
  const writeStatements = [];
  const summary = {
    scanned: 0,
    kept: 0,
    rejected: 0,
    rejectedRssOnly: 0,
    rejectedReadabilityBody: 0,
    keptViaReadability: 0,
    keptViaRssFallback: 0,
    feedMisses: 0,
    preservedNationalRefs: 0,
    wouldDelete: 0,
    wouldDemoteToNational: 0,
    wouldRetag: 0,
    deleted: 0,
    demotedToNational: 0,
    retagged: 0,
    errors: 0,
    errorReasons: {},
    feedIndexErrors: {},
    readabilityFallbackReasons: {}
  };

  async function flushWrites(force = false) {
    if (options.dryRun) return;
    if (!writeStatements.length) return;
    if (!force && writeStatements.length < 250) return;

    const sql = writeStatements.join("\n");

    await d1Execute(wranglerConfig, sql);
    writeStatements.length = 0;
  }

  for (let idx = 0; idx < items.length; idx += 1) {
    const item = items[idx];
    summary.scanned += 1;

    try {
      const feedKey = item.feedUrl || "__none__";
      if (!feedCache.has(feedKey)) {
        const built = await buildFeedIndex(item.feedUrl, options.feedCacheItems);
        feedCache.set(feedKey, built);
        if (built.errorReason) {
          bumpCounter(summary.feedIndexErrors, built.errorReason);
        }
      }

      const feedData = feedCache.get(feedKey);
      const feedEntry = feedData.index.get(item.url) || null;
      if (!feedEntry) summary.feedMisses += 1;

      const rssTitle = String(feedEntry?.title || item.title || "(untitled)");
      const rssDescription = String(feedEntry?.description || item.content || item.summary || "");
      const textToCheck = [rssTitle, rssDescription].filter(Boolean).join(" ");
      const rssCheck = isKentuckyRelevant(rssTitle, textOnly(textToCheck));

      const rejectOrDemoteSql = item.hasNonKyRefs
        ? [
            `DELETE FROM item_locations WHERE item_id=${q(item.id)} AND state_code='KY';`,
            `DELETE FROM feed_items WHERE item_id=${q(item.id)} AND feed_id IN (
              SELECT fi.feed_id
              FROM feed_items fi
              JOIN feeds f ON f.id = fi.feed_id
              WHERE fi.item_id=${q(item.id)} AND COALESCE(f.region_scope, 'ky')='ky'
            );`,
            `UPDATE items SET region_scope='national' WHERE id=${q(item.id)};`
          ]
        : [`DELETE FROM items WHERE id=${q(item.id)};`];

      if (!rssCheck.relevant) {
        summary.rejected += 1;
        summary.rejectedRssOnly += 1;
        if (item.hasNonKyRefs) {
          summary.wouldDemoteToNational += 1;
          summary.preservedNationalRefs += 1;
        } else {
          summary.wouldDelete += 1;
        }
        console.log(
          `[backfill-ky-relevance] reject stage=rss_only tier=${rssCheck.failedTier || "tier2_body"} action=${item.hasNonKyRefs ? "demote_to_national" : "delete"} title="${rssTitle}"`
        );
        if (!options.dryRun) {
          writeStatements.push(...rejectOrDemoteSql);
          await flushWrites();
        }
        continue;
      }

      const readability = await fetchReadableArticleText(item.url);
      const readabilityText = readability.text;
      const bodyForTagging = readabilityText || textOnly(textToCheck);

      if (readabilityText) {
        const readableCheck = isKentuckyRelevant(rssTitle, readabilityText);
        if (!readableCheck.relevant) {
          summary.rejected += 1;
          summary.rejectedReadabilityBody += 1;
          if (item.hasNonKyRefs) {
            summary.wouldDemoteToNational += 1;
            summary.preservedNationalRefs += 1;
          } else {
            summary.wouldDelete += 1;
          }
          console.log(
            `[backfill-ky-relevance] reject stage=readability_body tier=${readableCheck.failedTier || "tier2_body"} action=${item.hasNonKyRefs ? "demote_to_national" : "delete"} title="${rssTitle}"`
          );
          if (!options.dryRun) {
            writeStatements.push(...rejectOrDemoteSql);
            await flushWrites();
          }
          continue;
        }
        summary.keptViaReadability += 1;
      } else {
        summary.keptViaRssFallback += 1;
        if (readability.errorReason) {
          bumpCounter(summary.readabilityFallbackReasons, readability.errorReason);
        }
      }

      summary.kept += 1;
      summary.wouldRetag += 1;

      if (!options.dryRun) {
        const titleCounties = detectKyCounties(rssTitle);
        const bodyCounties = detectKyCounties(bodyForTagging);
        const taggedCounties = new Set([...titleCounties, ...bodyCounties].map((x) => normalizeCounty(x)).filter(Boolean));

        writeStatements.push(`UPDATE items SET region_scope='ky' WHERE id=${q(item.id)};`);
        writeStatements.push(`DELETE FROM item_locations WHERE item_id=${q(item.id)} AND state_code='KY';`);
        writeStatements.push(
          `INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (${q(item.id)}, 'KY', '');`
        );
        for (const county of taggedCounties) {
          writeStatements.push(
            `INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (${q(item.id)}, 'KY', ${q(county)});`
          );
        }
        await flushWrites();
      }
    } catch (err) {
      summary.errors += 1;
      bumpCounter(summary.errorReasons, classifyErrorReason(err));
      console.error(
        `[backfill-ky-relevance] error item=${item.id} title="${item.title}" error=${err instanceof Error ? err.message : String(err)}`
      );
      if (!options.dryRun && classifyErrorReason(err) === "d1_execute_failed") {
        throw err;
      }
    }

    if (summary.scanned % options.progressEvery === 0 || summary.scanned === items.length) {
      console.log(
        `[backfill-ky-relevance] progress ${summary.scanned}/${items.length} kept=${summary.kept} rejected=${summary.rejected} errors=${summary.errors}`
      );
    }
  }

  if (!options.dryRun) {
    await flushWrites(true);
    summary.demotedToNational = summary.wouldDemoteToNational;
    summary.deleted = summary.wouldDelete;
    summary.retagged = summary.wouldRetag;
  }

  console.log("[backfill-ky-relevance] complete");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(`[backfill-ky-relevance] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
