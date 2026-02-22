import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../types";
import { badRequest, notFound } from "../lib/errors";
import { normalizeCounty, safeJsonParse } from "../lib/utils";
import { runManualFeedIngest, runManualIngest } from "../ingest/ingest";
import { d1All, d1First, d1Run } from "../services/db";
import { insertAdminLog, requireRole } from "../services/security";
import { detectKyCounties, detectOtherStateNames, hasKySignal } from "../services/location";

const IngestionLogsQuery = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional()
});

const FeedHealthQuery = z.object({
  hours: z.coerce.number().min(1).max(24 * 14).default(48),
  limit: z.coerce.number().min(1).max(500).default(300)
});

const SummaryQueueQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "edited", "all"]).default("pending"),
  limit: z.coerce.number().min(1).max(200).default(50),
  cursor: z.string().optional()
});

const SummaryReviewBody = z.object({
  action: z.enum(["approve", "reject", "edit"]),
  summary: z.string().min(80).max(12000).optional(),
  note: z.string().max(1000).optional()
});

const TagCorrectionBody = z.object({
  state: z.string().length(2).default("KY"),
  counties: z.array(z.string().min(1).max(80)).max(20).default([]),
  note: z.string().max(500).optional()
});

const TagCorrectionQuery = z.object({
  itemId: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50)
});

const IngestionMetricsQuery = z.object({
  days: z.coerce.number().min(1).max(90).default(7)
});

const ErrorQuery = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  route: z.string().max(300).optional()
});

const KvLogQuery = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(new Date().toISOString().slice(0, 10)),
  event: z.string().max(120).optional(),
  limit: z.coerce.number().min(1).max(100).default(30),
  cursor: z.string().optional()
});

const RevalidateItemsBody = z.object({
  hours: z.coerce.number().min(1).max(24 * 90).default(72),
  limit: z.coerce.number().min(1).max(3000).default(800),
  minWords: z.coerce.number().min(1).max(1000).default(50),
  dryRun: z.boolean().default(true),
  includeNational: z.boolean().default(false)
});

function queryInput(c: any): Record<string, unknown> {
  const params = new URL(c.req.url).searchParams;
  return Object.fromEntries(params.entries());
}

function parseCompositeCursor(cursor: string | undefined): { ts: string; itemId: string } | null {
  if (!cursor) return null;
  const [ts, itemId] = cursor.split("|");
  if (!ts || !itemId) return null;
  return { ts, itemId };
}

function csvToArray(csv: unknown): string[] {
  return String(csv || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function wordCount(input: unknown): number {
  return String(input || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function locationSet(rows: Array<{ state_code: string; county: string }>): Set<string> {
  return new Set(rows.map((r) => `${String(r.state_code || "").toUpperCase()}|${normalizeCounty(r.county || "")}`));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

export function registerAdminRoutes(app: Hono<AppBindings>): void {
  app.post("/api/admin/feeds/reload", async (c) => {
    const admin = requireRole(c, "editor");
    const run = await runManualIngest(c.env);

    await insertAdminLog(c.env, admin.email, "feeds.reload", "ingester", "manual", {
      code: run.code,
      stderr: run.stderr.slice(-500)
    });

    if (!run.ok) {
      return c.json(
        {
          ok: false,
          code: run.code,
          stderr: run.stderr,
          stdout: run.stdout
        },
        500
      );
    }

    return c.json({
      ok: true,
      code: run.code,
      stdout: run.stdout,
      stderr: run.stderr
    });
  });

  app.post("/api/admin/feeds/:id/trigger", async (c) => {
    const admin = requireRole(c, "editor");
    const feedId = String(c.req.param("id") || "").trim();
    if (!feedId) badRequest("Feed id is required");

    const feed = await d1First<{ id: string; name: string }>(
      c.env.ky_news_db,
      "SELECT id, name FROM feeds WHERE id=? AND enabled=1",
      [feedId]
    );
    if (!feed) notFound("Feed not found or disabled");

    const run = await runManualFeedIngest(c.env, [feedId]);

    await insertAdminLog(c.env, admin.email, "feeds.trigger", "feed", feedId, {
      code: run.code,
      stderr: run.stderr.slice(-500)
    });

    if (!run.ok) {
      return c.json({ ok: false, code: run.code, stderr: run.stderr, stdout: run.stdout }, 500);
    }

    return c.json({ ok: true, code: run.code, feedId, feedName: feed.name, stdout: run.stdout, stderr: run.stderr });
  });

  app.post("/api/admin/items/revalidate", async (c) => {
    const admin = requireRole(c, "editor");
    const payload = await c.req.json().catch(() => null);
    const parsed = RevalidateItemsBody.safeParse(payload || {});
    if (!parsed.success) badRequest("Invalid payload");

    const options = parsed.data;
    const window = `-${options.hours} hours`;
    const scopeWhere = options.includeNational ? "" : "AND i.region_scope='ky'";

    const rows = await d1All<Record<string, unknown>>(
      c.env.ky_news_db,
      `
      SELECT
        i.id,
        i.title,
        i.url,
        i.summary,
        i.content,
        i.article_text_excerpt,
        i.region_scope,
        (
          SELECT group_concat(DISTINCT f.default_county)
          FROM feed_items fi
          JOIN feeds f ON f.id = fi.feed_id
          WHERE fi.item_id = i.id
            AND COALESCE(f.default_county, '') <> ''
        ) AS default_counties_csv
      FROM items i
      WHERE COALESCE(i.published_at, i.fetched_at) >= datetime('now', ?)
        ${scopeWhere}
      ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
      LIMIT ?
      `,
      [window, options.limit]
    );

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
      samples: [] as Array<Record<string, unknown>>
    };

    if (!rows.length) {
      await insertAdminLog(c.env, admin.email, "items.revalidate", "items", "batch", summary);
      return c.json({ ok: true, summary });
    }

    const itemIds = rows.map((r) => String(r.id || "")).filter(Boolean);
    const tagRows = itemIds.length
      ? await d1All<{ item_id: string; state_code: string; county: string }>(
          c.env.ky_news_db,
          `
          SELECT item_id, state_code, county
          FROM item_locations
          WHERE item_id IN (${itemIds.map(() => "?").join(",")})
          `,
          itemIds
        )
      : [];

    const tagsByItem = new Map<string, Array<{ state_code: string; county: string }>>();
    for (const row of tagRows) {
      const id = String(row.item_id || "");
      if (!id) continue;
      const next = tagsByItem.get(id) || [];
      next.push({
        state_code: String(row.state_code || "").toUpperCase(),
        county: normalizeCounty(row.county || "")
      });
      tagsByItem.set(id, next);
    }

    for (const row of rows) {
      const itemId = String(row.id || "");
      if (!itemId) continue;

      const title = String(row.title || "");
      const summaryText = String(row.summary || "");
      const content = String(row.content || "");
      const excerpt = String(row.article_text_excerpt || "");
      const qualityText = excerpt || content || summaryText || "";
      const words = wordCount(qualityText);

      if (words < options.minWords) {
        summary.wouldPrune += 1;
        if (summary.samples.length < 20) {
          summary.samples.push({
            item_id: itemId,
            action: "prune",
            words,
            title
          });
        }
        if (!options.dryRun) {
          const refs = await d1First<{ refs: number }>(
            c.env.ky_news_db,
            "SELECT COUNT(1) AS refs FROM feed_items WHERE item_id=?",
            [itemId]
          );
          await d1Run(c.env.ky_news_db, "DELETE FROM feed_items WHERE item_id=?", [itemId]);
          await d1Run(c.env.ky_news_db, "DELETE FROM item_locations WHERE item_id=?", [itemId]);
          await d1Run(c.env.ky_news_db, "DELETE FROM items WHERE id=?", [itemId]);
          summary.pruned += 1;
          summary.prunedFeedLinks += Number(refs?.refs || 0);
        }
        continue;
      }

      const fullText = [title, summaryText, content, excerpt].filter(Boolean).join("\n");
      const titleCounties = detectKyCounties(title);
      const baseCounties = detectKyCounties(fullText);
      const taggedCounties = new Set([...titleCounties, ...baseCounties].map((x) => normalizeCounty(x)).filter(Boolean));
      const titleKySignal = hasKySignal(title, titleCounties);
      const baseKySignal = hasKySignal(fullText, baseCounties);
      const hasStrongKySignal = titleKySignal || baseKySignal || taggedCounties.size > 0;

      const otherStates = detectOtherStateNames([title, summaryText, content].filter(Boolean).join("\n"));
      const hasOtherStateSignal = otherStates.length > 0;
      let urlSectionLooksOutOfState = false;
      try {
        const pathname = new URL(String(row.url || "")).pathname.toLowerCase();
        urlSectionLooksOutOfState = /\/(national|world|region)\//.test(pathname);
      } catch {
        urlSectionLooksOutOfState = false;
      }
      const shouldTagAsKy = hasStrongKySignal && !(urlSectionLooksOutOfState && !titleKySignal && !baseKySignal);

      if (shouldTagAsKy && (taggedCounties.size > 0 || !hasOtherStateSignal)) {
        for (const county of csvToArray(row.default_counties_csv)) {
          const normalized = normalizeCounty(county);
          if (normalized) taggedCounties.add(normalized);
        }
      }

      const existing = tagsByItem.get(itemId) || [];
      const nonKy = existing.filter((x) => x.state_code !== "KY");
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
        await d1Run(c.env.ky_news_db, "DELETE FROM item_locations WHERE item_id=? AND state_code='KY'", [itemId]);
        if (shouldTagAsKy) {
          await d1Run(
            c.env.ky_news_db,
            "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, 'KY', '')",
            [itemId]
          );
          for (const county of Array.from(taggedCounties)) {
            await d1Run(
              c.env.ky_news_db,
              "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, 'KY', ?)",
              [itemId, county]
            );
          }
        }
        summary.retagged += 1;
      }
    }

    await insertAdminLog(c.env, admin.email, "items.revalidate", "items", "batch", summary);
    return c.json({ ok: true, summary });
  });

  app.get("/api/admin/ingestion/logs", async (c) => {
    requireRole(c, "editor");
    const parsed = IngestionLogsQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const { limit, cursor } = parsed.data;

    const rows = await d1All<Record<string, unknown>>(
      c.env.ky_news_db,
      `
      SELECT
        fr.id,
        fr.started_at,
        fr.finished_at,
        fr.status,
        fr.source,
        fr.details_json,
        (
          SELECT COUNT(*)
          FROM feed_run_metrics frm
          WHERE frm.run_id = fr.id AND frm.status = 'error'
        ) AS feed_errors
      FROM fetch_runs fr
      ${cursor ? "WHERE fr.id < ?" : ""}
      ORDER BY fr.id DESC
      LIMIT ?
      `,
      cursor ? [cursor, limit] : [limit]
    );

    const logs = rows.map((row) => ({
      id: row.id,
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: row.status,
      source: row.source,
      feed_errors: Number(row.feed_errors || 0),
      details: safeJsonParse<Record<string, unknown> | null>(row.details_json, null)
    }));

    const nextCursor = logs.length ? Number(logs[logs.length - 1].id) : null;
    return c.json({ logs, nextCursor });
  });

  app.get("/api/admin/feeds/health", async (c) => {
    requireRole(c, "editor");
    const parsed = FeedHealthQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const window = `-${parsed.data.hours} hours`;
    const rows = await d1All<Record<string, unknown>>(
      c.env.ky_news_db,
      `
      SELECT
        f.id,
        f.name,
        f.url,
        f.category,
        f.region_scope,
        f.fetch_mode,
        f.scraper_id,
        f.enabled,
        f.last_checked_at,
        (
          SELECT frm.status FROM feed_run_metrics frm
          WHERE frm.feed_id=f.id
          ORDER BY frm.checked_at DESC
          LIMIT 1
        ) AS last_status,
        (
          SELECT frm.checked_at FROM feed_run_metrics frm
          WHERE frm.feed_id=f.id
          ORDER BY frm.checked_at DESC
          LIMIT 1
        ) AS last_metric_at,
        (
          SELECT frm.duration_ms FROM feed_run_metrics frm
          WHERE frm.feed_id=f.id
          ORDER BY frm.checked_at DESC
          LIMIT 1
        ) AS last_duration_ms,
        (
          SELECT frm.items_upserted FROM feed_run_metrics frm
          WHERE frm.feed_id=f.id
          ORDER BY frm.checked_at DESC
          LIMIT 1
        ) AS last_items_upserted,
        (
          SELECT COUNT(*) FROM feed_run_metrics frm
          WHERE frm.feed_id=f.id AND frm.status='error' AND frm.checked_at >= datetime('now', ?)
        ) AS errors_window,
        (
          SELECT COUNT(*) FROM feed_run_metrics frm
          WHERE frm.feed_id=f.id AND frm.checked_at >= datetime('now', ?)
        ) AS checks_window,
        (
          SELECT COUNT(*)
          FROM feed_items fi
          JOIN items i ON i.id = fi.item_id
          WHERE fi.feed_id=f.id
            AND COALESCE(i.published_at, i.fetched_at) >= datetime('now', ?)
        ) AS recent_items
      FROM feeds f
      WHERE f.enabled=1
      ORDER BY errors_window DESC, f.last_checked_at ASC
      LIMIT ?
      `,
      [window, window, window, parsed.data.limit]
    );

    const health = rows.map((row) => {
      const checks = Number(row.checks_window || 0);
      const errors = Number(row.errors_window || 0);
      const errorRate = checks > 0 ? errors / checks : 0;
      const lastStatus = String(row.last_status || "unknown");
      const status =
        checks === 0
          ? "unknown"
          : lastStatus === "error" || errorRate > 0.4
            ? "critical"
            : errorRate > 0.15
              ? "degraded"
              : "healthy";

      return {
        id: row.id,
        name: row.name,
        url: row.url,
        category: row.category,
        region_scope: row.region_scope,
        fetch_mode: row.fetch_mode,
        scraper_id: row.scraper_id,
        enabled: Number(row.enabled) === 1,
        last_checked_at: row.last_checked_at,
        last_metric_at: row.last_metric_at,
        last_status: lastStatus,
        last_duration_ms: Number(row.last_duration_ms || 0),
        last_items_upserted: Number(row.last_items_upserted || 0),
        recent_items: Number(row.recent_items || 0),
        checks_window: checks,
        errors_window: errors,
        error_rate: Number(errorRate.toFixed(3)),
        health_status: status
      };
    });

    return c.json({ hours: parsed.data.hours, feeds: health });
  });

  app.get("/api/admin/summaries/review", async (c) => {
    requireRole(c, "editor");
    const parsed = SummaryQueueQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const cursor = parseCompositeCursor(parsed.data.cursor);
    const where: string[] = [];
    const binds: unknown[] = [];

    if (parsed.data.status !== "all") {
      where.push("q.status = ?");
      binds.push(parsed.data.status);
    }

    if (cursor) {
      where.push("(q.updated_at < ? OR (q.updated_at = ? AND q.item_id < ?))");
      binds.push(cursor.ts, cursor.ts, cursor.itemId);
    }

    const rows = await d1All<Record<string, unknown>>(
      c.env.ky_news_db,
      `
      SELECT
        q.item_id,
        q.status,
        q.queue_reason,
        q.reviewer_email,
        q.reviewed_at,
        q.note,
        q.created_at,
        q.updated_at,
        i.title,
        i.url,
        i.published_at,
        i.summary,
        i.region_scope,
        ais.model,
        ais.generated_at
      FROM summary_review_queue q
      JOIN items i ON i.id = q.item_id
      LEFT JOIN item_ai_summaries ais ON ais.item_id = q.item_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY q.updated_at DESC, q.item_id DESC
      LIMIT ?
      `,
      [...binds, parsed.data.limit]
    );

    const queue = rows.map((row) => ({
      item_id: row.item_id,
      status: row.status,
      queue_reason: row.queue_reason,
      reviewer_email: row.reviewer_email,
      reviewed_at: row.reviewed_at,
      note: row.note,
      created_at: row.created_at,
      updated_at: row.updated_at,
      item: {
        title: row.title,
        url: row.url,
        published_at: row.published_at,
        summary: row.summary,
        region_scope: row.region_scope
      },
      ai: {
        model: row.model,
        generated_at: row.generated_at
      }
    }));

    const tail = queue[queue.length - 1];
    const nextCursor = tail ? `${tail.updated_at}|${tail.item_id}` : null;

    return c.json({ queue, nextCursor });
  });

  app.post("/api/admin/summaries/:itemId/review", async (c) => {
    const admin = requireRole(c, "editor");
    const itemId = String(c.req.param("itemId") || "");
    if (!itemId) badRequest("Item id is required");

    const payload = await c.req.json().catch(() => null);
    const parsed = SummaryReviewBody.safeParse(payload || {});
    if (!parsed.success) badRequest("Invalid payload");

    const item = await d1First<{ id: string; summary: string | null }>(
      c.env.ky_news_db,
      "SELECT id, summary FROM items WHERE id=?",
      [itemId]
    );
    if (!item) notFound("Item not found");

    if (parsed.data.action === "edit" && !parsed.data.summary) {
      badRequest("Edited summary is required");
    }

    let reviewedSummary = parsed.data.summary || item.summary || null;
    let status = parsed.data.action === "approve" ? "approved" : parsed.data.action === "reject" ? "rejected" : "edited";

    if ((parsed.data.action === "edit" || parsed.data.action === "approve") && reviewedSummary) {
      await d1Run(c.env.ky_news_db, "UPDATE items SET summary=? WHERE id=?", [reviewedSummary, itemId]);
      await d1Run(
        c.env.ky_news_db,
        `
        INSERT INTO item_ai_summaries (item_id, summary, model, source_hash, generated_at)
        VALUES (?, ?, 'human-reviewed', NULL, datetime('now'))
        ON CONFLICT(item_id) DO UPDATE SET
          summary=excluded.summary,
          model=excluded.model,
          generated_at=excluded.generated_at
        `,
        [itemId, reviewedSummary]
      );
      const ttl = Number(c.env.SUMMARY_CACHE_TTL_SECONDS || 30 * 24 * 60 * 60);
      await Promise.all([
        c.env.CACHE.put(`summary:v2:${itemId}`, reviewedSummary, {
          expirationTtl: ttl
        }),
        c.env.CACHE.put(`summary:v1:${itemId}`, reviewedSummary, {
          expirationTtl: ttl
        })
      ]);
    }

    await d1Run(
      c.env.ky_news_db,
      `
      INSERT INTO summary_review_queue (
        item_id, status, queue_reason, reviewer_email, reviewed_at, reviewed_summary, note, created_at, updated_at
      ) VALUES (?, ?, 'manual_review', ?, datetime('now'), ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(item_id) DO UPDATE SET
        status=excluded.status,
        reviewer_email=excluded.reviewer_email,
        reviewed_at=excluded.reviewed_at,
        reviewed_summary=excluded.reviewed_summary,
        note=excluded.note,
        updated_at=excluded.updated_at
      `,
      [itemId, status, admin.email, reviewedSummary, parsed.data.note || null]
    );

    await insertAdminLog(c.env, admin.email, "summary.review", "item", itemId, {
      action: parsed.data.action,
      note: parsed.data.note || null
    });

    return c.json({ ok: true, itemId, status });
  });

  app.get("/api/admin/items/:id/tags", async (c) => {
    requireRole(c, "editor");
    const id = String(c.req.param("id") || "");

    const item = await d1First<{ id: string; title: string; url: string }>(
      c.env.ky_news_db,
      "SELECT id, title, url FROM items WHERE id=?",
      [id]
    );
    if (!item) notFound("Item not found");

    const tags = await d1All<{ state_code: string; county: string }>(
      c.env.ky_news_db,
      "SELECT state_code, county FROM item_locations WHERE item_id=? ORDER BY state_code, county",
      [id]
    );

    const states = Array.from(new Set(tags.filter((t) => !t.county).map((t) => t.state_code)));
    const counties = tags.filter((t) => t.county).map((t) => t.county);

    return c.json({
      item,
      tags: {
        states,
        counties
      }
    });
  });

  app.put("/api/admin/items/:id/tags", async (c) => {
    const admin = requireRole(c, "editor");
    const itemId = String(c.req.param("id") || "");

    const payload = await c.req.json().catch(() => null);
    const parsed = TagCorrectionBody.safeParse(payload || {});
    if (!parsed.success) badRequest("Invalid payload");

    const item = await d1First<{ id: string }>(c.env.ky_news_db, "SELECT id FROM items WHERE id=?", [itemId]);
    if (!item) notFound("Item not found");

    const previousRows = await d1All<{ state_code: string; county: string }>(
      c.env.ky_news_db,
      "SELECT state_code, county FROM item_locations WHERE item_id=? ORDER BY state_code, county",
      [itemId]
    );

    const previous = {
      states: Array.from(new Set(previousRows.filter((r) => !r.county).map((r) => r.state_code))),
      counties: previousRows.filter((r) => r.county).map((r) => r.county)
    };

    const state = parsed.data.state.toUpperCase();
    const counties = Array.from(new Set(parsed.data.counties.map((c) => normalizeCounty(c)).filter(Boolean))).slice(0, 20);

    await d1Run(c.env.ky_news_db, "DELETE FROM item_locations WHERE item_id=?", [itemId]);
    await d1Run(c.env.ky_news_db, "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, ?, '')", [
      itemId,
      state
    ]);

    for (const county of counties) {
      await d1Run(
        c.env.ky_news_db,
        "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, ?, ?)",
        [itemId, state, county]
      );
    }

    const nextTags = { states: [state], counties };

    await d1Run(
      c.env.ky_news_db,
      `
      INSERT INTO item_tag_corrections (
        id, item_id, actor_email, previous_tags_json, new_tags_json, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `,
      [
        randomUUID(),
        itemId,
        admin.email,
        JSON.stringify(previous),
        JSON.stringify(nextTags),
        parsed.data.note || null
      ]
    );

    await insertAdminLog(c.env, admin.email, "tags.correct", "item", itemId, {
      previous,
      next: nextTags,
      note: parsed.data.note || null
    });

    return c.json({ ok: true, itemId, tags: nextTags });
  });

  app.get("/api/admin/tags/corrections", async (c) => {
    requireRole(c, "editor");
    const parsed = TagCorrectionQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const rows = await d1All<Record<string, unknown>>(
      c.env.ky_news_db,
      `
      SELECT
        tc.id,
        tc.item_id,
        tc.actor_email,
        tc.previous_tags_json,
        tc.new_tags_json,
        tc.note,
        tc.created_at,
        i.title,
        i.url
      FROM item_tag_corrections tc
      JOIN items i ON i.id = tc.item_id
      ${parsed.data.itemId ? "WHERE tc.item_id = ?" : ""}
      ORDER BY tc.created_at DESC
      LIMIT ?
      `,
      parsed.data.itemId ? [parsed.data.itemId, parsed.data.limit] : [parsed.data.limit]
    );

    const corrections = rows.map((r) => ({
      id: r.id,
      item_id: r.item_id,
      actor_email: r.actor_email,
      previous_tags: safeJsonParse<Record<string, unknown>>(r.previous_tags_json, {}),
      new_tags: safeJsonParse<Record<string, unknown>>(r.new_tags_json, {}),
      note: r.note,
      created_at: r.created_at,
      item: {
        title: r.title,
        url: r.url
      }
    }));

    return c.json({ corrections });
  });

  app.get("/api/admin/metrics/ingestion", async (c) => {
    requireRole(c, "editor");
    const parsed = IngestionMetricsQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const window = `-${parsed.data.days} days`;
    const rows = await d1All<Record<string, unknown>>(
      c.env.ky_news_db,
      `
      SELECT
        date(created_at) AS day,
        COUNT(*) AS runs,
        SUM(feeds_processed) AS feeds_processed,
        SUM(feeds_updated) AS feeds_updated,
        SUM(items_seen) AS items_seen,
        SUM(items_upserted) AS items_upserted,
        SUM(summaries_generated) AS summaries_generated,
        SUM(images_mirrored) AS images_mirrored,
        SUM(errors) AS errors
      FROM ingestion_metrics
      WHERE created_at >= datetime('now', ?)
      GROUP BY date(created_at)
      ORDER BY day DESC
      `,
      [window]
    );

    return c.json({ days: parsed.data.days, metrics: rows });
  });

  app.get("/api/admin/errors", async (c) => {
    requireRole(c, "editor");
    const parsed = ErrorQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const rows = await d1All<Record<string, unknown>>(
      c.env.ky_news_db,
      `
      SELECT id, request_id, route, method, status_code, actor_email, error_message, error_stack, meta_json, created_at
      FROM app_error_events
      ${parsed.data.route ? "WHERE route = ?" : ""}
      ORDER BY created_at DESC
      LIMIT ?
      `,
      parsed.data.route ? [parsed.data.route, parsed.data.limit] : [parsed.data.limit]
    );

    const errors = rows.map((r) => ({
      id: r.id,
      request_id: r.request_id,
      route: r.route,
      method: r.method,
      status_code: r.status_code,
      actor_email: r.actor_email,
      error_message: r.error_message,
      error_stack: r.error_stack,
      meta: safeJsonParse<Record<string, unknown> | null>(r.meta_json, null),
      created_at: r.created_at
    }));

    return c.json({ errors });
  });

  app.get("/api/admin/logs/kv", async (c) => {
    requireRole(c, "editor");
    const parsed = KvLogQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const prefix = parsed.data.event
      ? `log:v1:${parsed.data.day}:${parsed.data.event}:`
      : `log:v1:${parsed.data.day}:`;

    const listed = await c.env.CACHE.list({
      prefix,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor
    });

    const pairs = await Promise.all(
      listed.keys.map(async (k) => {
        const value = await c.env.CACHE.get(k.name);
        return value ? safeJsonParse<Record<string, unknown>>(value, { raw: value }) : null;
      })
    );

    const logs = pairs.filter(Boolean);
    return c.json({
      day: parsed.data.day,
      event: parsed.data.event || null,
      logs,
      cursor: listed.list_complete ? null : listed.cursor
    });
  });
}
