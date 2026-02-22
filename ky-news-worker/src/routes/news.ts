import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../types";
import { badGateway, badRequest, notFound, unsupportedMedia } from "../lib/errors";
import { buildSearchClause } from "../lib/search";
import {
  NEWS_SCOPES,
  isKy,
  isPrivateHost,
  mapItemRow,
  normalizeCounty,
  parseCountyList,
  rankAndFilterItems,
  stripExecutableHtml
} from "../lib/utils";
import { d1All, d1First } from "../services/db";
import { respondCachedJson } from "../services/apiCache";
import { detectKyQueryCounties } from "../services/location";

const ItemsQuery = z.object({
  feedId: z.string().optional(),
  category: z.string().min(1).max(80).optional(),
  scope: z.enum(NEWS_SCOPES).default("ky"),
  state: z.string().length(2).optional(),
  county: z.string().min(1).max(80).optional(),
  counties: z.union([z.string(), z.array(z.string())]).optional(),
  hours: z.coerce.number().min(1).max(24 * 365).default(2),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30)
});

const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  scope: z.enum(NEWS_SCOPES).default("ky"),
  state: z.string().length(2).optional(),
  county: z.string().min(1).max(80).optional(),
  counties: z.union([z.string(), z.array(z.string())]).optional(),
  hours: z.coerce.number().min(1).max(24 * 365).optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30)
});

const CountiesQuery = z.object({
  state: z.string().length(2).default("KY"),
  hours: z.coerce.number().min(1).max(24 * 365).default(2)
});

const OpenProxyQuery = z.object({
  url: z.string().url()
});

function queryInput(c: any): Record<string, unknown> {
  const url = new URL(c.req.url);
  const countyList = url.searchParams.getAll("counties");

  return {
    ...Object.fromEntries(url.searchParams.entries()),
    counties: countyList.length > 1 ? countyList : countyList[0] || undefined
  };
}

function parseKeysetCursor(cursor: string | undefined): { ts: string; id: string | null } | null {
  if (!cursor) return null;
  const [ts, id] = cursor.split("|");
  if (!ts) return null;
  return { ts, id: id || null };
}

export function registerNewsRoutes(app: Hono<AppBindings>): void {
  app.get("/api/health", (c) => c.json({ ok: true, now: new Date().toISOString() }));

  app.get("/api/feeds", async (c) => {
    const parsed = z.object({ scope: z.enum(NEWS_SCOPES).default("all") }).safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const scope = parsed.data.scope;
    const cacheTtl = Math.max(120, Number(c.env.API_CACHE_TTL_SECONDS || "120"));
    return respondCachedJson(c, {
      ttlSeconds: cacheTtl,
      producer: async () => {
        const rows = await d1All(
          c.env.ky_news_db,
          `
          SELECT id, name, category, url, state_code, region_scope, enabled
          FROM feeds
          WHERE enabled=1
            AND (?='all' OR region_scope=?)
          ORDER BY CASE region_scope WHEN 'ky' THEN 0 ELSE 1 END, category, name
          `,
          [scope, scope]
        );
        return { feeds: rows };
      }
    });
  });

  app.get("/api/items", async (c) => {
    const parsed = ItemsQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const { feedId, category, scope, state, county, counties, hours, cursor, limit } = parsed.data;
    const countyList = county ? [normalizeCounty(county)] : parseCountyList(counties);

    if ((state || countyList.length) && scope === "national") {
      badRequest("State/county filters only apply to KY scope");
    }

    const where: string[] = [];
    const binds: unknown[] = [];

    if (hours != null) {
      where.push("COALESCE(i.published_at, i.fetched_at) >= datetime('now', ?)");
      binds.push(`-${hours} hours`);
    }

    if (scope !== "all") {
      where.push("i.region_scope = ?");
      binds.push(scope);
    }

    const needsFi = Boolean(feedId || category);
    if (feedId) {
      where.push("fi.feed_id = ?");
      binds.push(feedId);
    }
    if (category) {
      where.push("f.category = ?");
      binds.push(category);
    }

    const stateCode = (state || "KY").toUpperCase();
    const needsLoc = scope !== "national" && Boolean(state || countyList.length);

    if (needsLoc) {
      where.push("i.region_scope = 'ky'");
      if (countyList.length) {
        where.push(`il.state_code = ? AND il.county IN (${countyList.map(() => "?").join(",")})`);
        binds.push(stateCode, ...countyList);
      } else {
        where.push("il.state_code = ? AND il.county = ''");
        binds.push(stateCode);
      }
    }

    const parsedCursor = parseKeysetCursor(cursor);
    if (parsedCursor) {
      if (parsedCursor.id) {
        where.push("(COALESCE(i.published_at, i.fetched_at) < ? OR (COALESCE(i.published_at, i.fetched_at) = ? AND i.id < ?))");
        binds.push(parsedCursor.ts, parsedCursor.ts, parsedCursor.id);
      } else {
        where.push("COALESCE(i.published_at, i.fetched_at) < ?");
        binds.push(parsedCursor.ts);
      }
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
      ORDER BY sort_ts DESC, i.id DESC
      LIMIT ?
    `;

    binds.push(Math.min(limit * 4, 400));

    const rows = await d1All<Record<string, unknown>>(c.env.ky_news_db, sql, binds);
    const mapped = rows.map((row) => mapItemRow(row as Record<string, unknown>)) as unknown as Array<
      Record<string, unknown> & { id: string; title: string; url: string; sort_ts?: string }
    >;
    const items = rankAndFilterItems(mapped, limit);
    const tail = items[items.length - 1] as any;
    const nextCursor = items.length ? `${String(tail.sort_ts || "")}|${String(tail.id || "")}` : null;
    c.header("cache-control", "public, max-age=20, s-maxage=45, stale-while-revalidate=90");
    return c.json({ items, nextCursor });
  });

  app.get("/api/counties", async (c) => {
    const parsed = CountiesQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const { state, hours } = parsed.data;
    if (!isKy(state)) badRequest("Only KY county counts are supported currently");

    const cacheTtl = Math.max(60, Number(c.env.API_CACHE_TTL_SECONDS || "120"));
    return respondCachedJson(c, {
      ttlSeconds: cacheTtl,
      producer: async () => {
        const rows = await d1All<{ county: string; count: number }>(
          c.env.ky_news_db,
          `
          SELECT il.county AS county, COUNT(DISTINCT il.item_id) AS count
          FROM item_locations il
          JOIN items i ON i.id = il.item_id
          WHERE il.state_code = ?
            AND il.county != ''
            AND i.region_scope = 'ky'
            AND COALESCE(i.published_at, i.fetched_at) >= datetime('now', ?)
          GROUP BY il.county
          ORDER BY il.county
          `,
          [state.toUpperCase(), `-${hours} hours`]
        );
        return { state: state.toUpperCase(), hours, counties: rows };
      }
    });
  });

  app.get("/api/search", async (c) => {
    const parsed = SearchQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const { q, scope, state, county, counties, hours, sort, cursor, limit } = parsed.data;
    const countyList = county ? [normalizeCounty(county)] : parseCountyList(counties);

    if ((state || countyList.length) && scope === "national") {
      badRequest("State/county filters only apply to KY scope");
    }

    const where: string[] = [];
    const binds: unknown[] = [];

    const search = buildSearchClause(q);
    const hintedCounties =
      scope === "national"
        ? []
        : Array.from(new Set(detectKyQueryCounties(q).map((x) => normalizeCounty(x)).filter(Boolean)));
    if (hintedCounties.length) {
      where.push(
        `(${search.clause} OR EXISTS (
          SELECT 1
          FROM item_locations ilh
          WHERE ilh.item_id = i.id
            AND ilh.state_code = 'KY'
            AND ilh.county IN (${hintedCounties.map(() => "?").join(",")})
        ))`
      );
      binds.push(...search.binds, ...hintedCounties);
    } else {
      where.push(search.clause);
      binds.push(...search.binds);
    }

    if (hours != null) {
      where.push("COALESCE(i.published_at, i.fetched_at) >= datetime('now', ?)");
      binds.push(`-${hours} hours`);
    }

    if (scope !== "all") {
      where.push("i.region_scope = ?");
      binds.push(scope);
    }

    const needsLoc = scope !== "national" && Boolean(state || countyList.length);
    if (needsLoc) {
      const stateCode = (state || "KY").toUpperCase();
      where.push("i.region_scope = 'ky'");

      if (countyList.length) {
        where.push(`il.state_code = ? AND il.county IN (${countyList.map(() => "?").join(",")})`);
        binds.push(stateCode, ...countyList);
      } else {
        where.push("il.state_code = ? AND il.county = ''");
        binds.push(stateCode);
      }
    }

    const parsedCursor = parseKeysetCursor(cursor);
    if (parsedCursor) {
      if (sort === "oldest") {
        if (parsedCursor.id) {
          where.push(
            "(COALESCE(i.published_at, i.fetched_at) > ? OR (COALESCE(i.published_at, i.fetched_at) = ? AND i.id > ?))"
          );
          binds.push(parsedCursor.ts, parsedCursor.ts, parsedCursor.id);
        } else {
          where.push("COALESCE(i.published_at, i.fetched_at) > ?");
          binds.push(parsedCursor.ts);
        }
      } else {
        if (parsedCursor.id) {
          where.push(
            "(COALESCE(i.published_at, i.fetched_at) < ? OR (COALESCE(i.published_at, i.fetched_at) = ? AND i.id < ?))"
          );
          binds.push(parsedCursor.ts, parsedCursor.ts, parsedCursor.id);
        } else {
          where.push("COALESCE(i.published_at, i.fetched_at) < ?");
          binds.push(parsedCursor.ts);
        }
      }
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
      ORDER BY sort_ts ${sort === "oldest" ? "ASC" : "DESC"}, i.id ${sort === "oldest" ? "ASC" : "DESC"}
      LIMIT ?
    `;

    binds.push(Math.min(limit * 4, 400));

    const rows = await d1All<Record<string, unknown>>(c.env.ky_news_db, sql, binds);
    const mapped = rows.map((row) => mapItemRow(row as Record<string, unknown>)) as unknown as Array<
      Record<string, unknown> & { id: string; title: string; url: string; sort_ts?: string }
    >;
    const items = rankAndFilterItems(mapped, limit);
    const tail = items[items.length - 1] as any;
    const nextCursor = items.length ? `${String(tail.sort_ts || "")}|${String(tail.id || "")}` : null;
    c.header("cache-control", "public, max-age=15, s-maxage=30, stale-while-revalidate=60");
    return c.json({ items, nextCursor });
  });

  app.get("/api/items/:id", async (c) => {
    const id = c.req.param("id");
    const cacheTtl = Math.max(60, Number(c.env.API_CACHE_TTL_SECONDS || "120"));
    return respondCachedJson(c, {
      ttlSeconds: cacheTtl,
      producer: async () => {
        const row = await d1First<Record<string, unknown>>(
          c.env.ky_news_db,
          `
          SELECT
            id, title, url, author, region_scope, published_at, summary, content, image_url,
            (
              SELECT group_concat(DISTINCT state_code)
              FROM item_locations
              WHERE item_id=items.id AND county=''
            ) AS states_csv,
            (
              SELECT group_concat(DISTINCT county)
              FROM item_locations
              WHERE item_id=items.id AND county!=''
            ) AS counties_csv
          FROM items
          WHERE id=?
          `,
          [id]
        );

        if (!row) notFound("Not found");
        return { item: mapItemRow(row) };
      }
    });
  });

  app.get("/api/open-proxy", async (c) => {
    const parsed = OpenProxyQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid URL");

    let target: URL;
    try {
      target = new URL(parsed.data.url);
    } catch {
      badRequest("Invalid URL");
    }

    if (!["http:", "https:"].includes(target.protocol)) {
      badRequest("Only HTTP(S) URLs are allowed");
    }
    if (isPrivateHost(target.hostname)) {
      badRequest("Private/local hosts are not allowed");
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15_000);

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
        badGateway(`Upstream returned ${upstream.status}`);
      }

      const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
        unsupportedMedia("Upstream content is not HTML");
      }

      const finalUrl = upstream.url || target.toString();
      let html = await upstream.text();
      if (html.length > 1_500_000) html = html.slice(0, 1_500_000);

      const safeHtml = stripExecutableHtml(html);
      const titleMatch = safeHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

      const framedHtml = [
        "<!doctype html><html><head>",
        `<base href=\"${finalUrl.replace(/\"/g, "&quot;")}\">`,
        '<meta charset="utf-8"/>',
        '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
        "<style>html,body{margin:0;padding:0;background:#fff;color:#111;font-family:Roboto,Arial,sans-serif}img,video,iframe{max-width:100%;height:auto}body{padding:10px}</style>",
        "</head><body>",
        safeHtml,
        "</body></html>"
      ].join("");

      return c.json({ url: target.toString(), finalUrl, title, html: framedHtml });
    } catch (err) {
      badGateway(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get("/api/media/:key{.+}", async (c) => {
    const rawKey = c.req.param("key") || "";
    let key = "";
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      badRequest("Invalid object key");
    }
    if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes("..")) {
      badRequest("Invalid object key");
    }

    let obj = await c.env.ky_news_media.get(key);
    if (!obj) {
      const keyMatch = key.match(/^news\/([a-f0-9]{24})\.[a-z0-9]+$/i);
      if (keyMatch) {
        const mapped = await d1First<{ r2_key: string }>(
          c.env.ky_news_db,
          "SELECT r2_key FROM item_media WHERE item_id=? LIMIT 1",
          [keyMatch[1]]
        );
        if (mapped?.r2_key && mapped.r2_key !== key) {
          return c.redirect(`/api/media/${encodeURIComponent(mapped.r2_key)}`, 302);
        }
      }
      notFound("Media not found");
    }

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    if (!headers.has("cache-control")) {
      headers.set("cache-control", "public, max-age=2592000, immutable");
    }

    if (c.req.method === "HEAD") {
      return new Response(null, { headers });
    }
    return new Response(obj.body, { headers });
  });
}
