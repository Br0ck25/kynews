import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.mjs";
import { ensureSchema } from "./schema.mjs";
import { buildSearchClause, isKy, mapItemRow, normalizeCounty } from "./search.mjs";
import { insertAdminLog, requireAdmin } from "./security.mjs";
import { registerWeatherRoutes } from "./weather.mjs";
import { registerLostFoundRoutes } from "./lostFound.mjs";
import { registerSeoRoutes } from "./seo.mjs";

const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });

await app.register(cors, {
  origin: [/^http:\/\/localhost:5173$/, /^http:\/\/127\.0\.0\.1:5173$/, /^http:\/\/\[::1\]:5173$/],
  credentials: false
});

await app.register(sensible);

app.addContentTypeParser(/^image\/.*/, { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});

app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");
const uploadDir = path.resolve(repoRoot, "data", "uploads", "lost-found");
const ingesterScript = path.resolve(repoRoot, "apps", "ingester", "src", "ingester.mjs");

await fs.mkdir(uploadDir, { recursive: true });

{
  const db = openDb();
  ensureSchema(db);
  db.close();
}

app.get("/api/health", async () => ({ ok: true, now: new Date().toISOString() }));

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

  const nonPaidFingerprints = new Set(ranked.filter((x) => !x._isPaid && x._fp).map((x) => x._fp));
  const seenTitle = new Set();
  const seenCanonicalUrl = new Set();
  const seenSourceTitle = new Set();
  const filtered = [];
  for (const item of ranked) {
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
  const paid = filtered.filter((item) => item._isPaid);
  const pickedNonPaid = nonPaid.slice(0, limit);
  const paidAllowance =
    pickedNonPaid.length === 0
      ? Math.min(limit, PAID_FALLBACK_WHEN_EMPTY_LIMIT)
      : Math.min(PAID_FALLBACK_LIMIT, Math.max(1, Math.floor(limit * 0.1)));
  const pickedPaid = paid.slice(0, paidAllowance);

  return [...pickedNonPaid, ...pickedPaid]
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

app.get("/api/feeds", async (req) => {
  const parsed = z
    .object({ scope: z.enum(NEWS_SCOPES).default("all") })
    .safeParse(req.query ?? {});

  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");
  const { scope } = parsed.data;

  const db = openDb();
  try {
    ensureSchema(db);
    const rows = db
      .prepare(
        `
        SELECT id, name, category, url, state_code, region_scope, enabled
        FROM feeds
        WHERE enabled=1
          AND (@scope='all' OR region_scope=@scope)
        ORDER BY CASE region_scope WHEN 'ky' THEN 0 ELSE 1 END, category, name
      `
      )
      .all({ scope });
    return { feeds: rows };
  } finally {
    db.close();
  }
});

const ItemsQuery = z.object({
  feedId: z.string().optional(),
  category: z.string().min(1).max(80).optional(),
  scope: z.enum(NEWS_SCOPES).default("ky"),
  state: z.string().length(2).optional(),
  county: z.string().min(1).max(80).optional(),
  counties: z.union([z.string(), z.array(z.string())]).optional(),
  hours: z.coerce.number().min(1).max(720).default(2),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30)
});

app.get("/api/items", async (req) => {
  const parsed = ItemsQuery.safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

  const { feedId, category, scope, state, county, counties, hours, cursor, limit } = parsed.data;
  const countyList = county ? [normalizeCounty(county)] : parseCountyList(counties);

  if ((state || countyList.length) && scope === "national") {
    return app.httpErrors.badRequest("State/county filters only apply to KY scope");
  }

  const db = openDb();
  try {
    ensureSchema(db);

    const where = [];
    const params = { since: `-${hours} hours`, limit: Math.min(limit * 4, 400) };

    where.push("COALESCE(i.published_at, i.fetched_at) >= datetime('now', @since)");

    if (scope !== "all") {
      where.push("i.region_scope = @scope");
      params.scope = scope;
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
    }

    if (cursor) {
      where.push("COALESCE(i.published_at, i.fetched_at) < @cursor");
      params.cursor = cursor;
    }

    const sql = `
      SELECT DISTINCT
        i.id, i.title, i.url, i.author, i.region_scope, i.published_at, i.summary, i.content, i.image_url,
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
      WHERE ${where.join(" AND ")}
      ORDER BY sort_ts DESC
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

const CountiesQuery = z.object({
  state: z.string().length(2).default("KY"),
  hours: z.coerce.number().min(1).max(720).default(2)
});

app.get("/api/counties", async (req) => {
  const parsed = CountiesQuery.safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

  const { state, hours } = parsed.data;
  if (!isKy(state)) return app.httpErrors.badRequest("Only KY county counts are supported currently");

  const db = openDb();
  try {
    ensureSchema(db);
    const rows = db
      .prepare(
        `
        SELECT il.county AS county, COUNT(DISTINCT il.item_id) AS count
        FROM item_locations il
        JOIN items i ON i.id = il.item_id
        WHERE il.state_code = @stateCode
          AND il.county != ''
          AND i.region_scope = 'ky'
          AND COALESCE(i.published_at, i.fetched_at) >= datetime('now', @since)
        GROUP BY il.county
        ORDER BY il.county
      `
      )
      .all({ stateCode: state.toUpperCase(), since: `-${hours} hours` });

    return { state: state.toUpperCase(), hours, counties: rows };
  } finally {
    db.close();
  }
});

const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  scope: z.enum(NEWS_SCOPES).default("ky"),
  state: z.string().length(2).optional(),
  county: z.string().min(1).max(80).optional(),
  counties: z.union([z.string(), z.array(z.string())]).optional(),
  hours: z.coerce.number().min(1).max(720).default(2),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30)
});

app.get("/api/search", async (req) => {
  const parsed = SearchQuery.safeParse(req.query ?? {});
  if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

  const { q, scope, state, county, counties, hours, cursor, limit } = parsed.data;
  const countyList = county ? [normalizeCounty(county)] : parseCountyList(counties);

  if ((state || countyList.length) && scope === "national") {
    return app.httpErrors.badRequest("State/county filters only apply to KY scope");
  }

  const db = openDb();
  try {
    ensureSchema(db);

    const where = [];
    const params = { limit: Math.min(limit * 4, 400), since: `-${hours} hours` };

    where.push(buildSearchClause(q, params));
    where.push("COALESCE(i.published_at, i.fetched_at) >= datetime('now', @since)");

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
      where.push("COALESCE(i.published_at, i.fetched_at) < @cursor");
      params.cursor = cursor;
    }

    const sql = `
      SELECT DISTINCT
        i.id, i.title, i.url, i.author, i.region_scope, i.published_at, i.summary, i.content, i.image_url,
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
      ORDER BY sort_ts DESC
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

app.get("/api/items/:id", async (req) => {
  const id = req.params?.id;
  const db = openDb();
  try {
    ensureSchema(db);
    const itemRaw = db
      .prepare(
        "SELECT id, title, url, author, region_scope, published_at, summary, content, image_url, (SELECT group_concat(DISTINCT state_code) FROM item_locations WHERE item_id=items.id AND county='') AS states_csv, (SELECT group_concat(DISTINCT county) FROM item_locations WHERE item_id=items.id AND county!='') AS counties_csv FROM items WHERE id=?"
      )
      .get(id);

    if (!itemRaw) return app.httpErrors.notFound("Not found");
    return { item: mapItemRow(itemRaw) };
  } finally {
    db.close();
  }
});

const OpenProxyQuery = z.object({
  url: z.string().url()
});

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
      "<meta charset=\"utf-8\"/>",
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>",
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

registerWeatherRoutes(app, openDb);
registerLostFoundRoutes(app, openDb, uploadDir);
registerSeoRoutes(app, openDb);

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

app.post("/api/admin/feeds/reload", async (req) => {
  const admin = requireAdmin(app, req);
  const run = await runIngestOnce();
  const ok = Number(run.code) === 0;

  const db = openDb();
  try {
    ensureSchema(db);
    insertAdminLog(db, admin.email, "feeds.reload", "ingester", "manual", {
      code: run.code,
      stderr: run.stderr.slice(-500)
    });
  } finally {
    db.close();
  }

  if (!ok) {
    return app.httpErrors.internalServerError({
      ok: false,
      code: run.code,
      stderr: run.stderr,
      stdout: run.stdout
    });
  }

  return {
    ok: true,
    code: run.code,
    stdout: run.stdout,
    stderr: run.stderr
  };
});

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
app.listen({ port, host });
