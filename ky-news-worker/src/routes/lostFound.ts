import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../types";
import { badRequest, notFound, tooManyRequests, unauthorized } from "../lib/errors";
import { LOST_FOUND_STATUSES, LOST_FOUND_TYPES, normalizeCounty } from "../lib/utils";
import { d1All, d1First, d1Run } from "../services/db";
import { decryptText, encryptText, hashIp } from "../lib/crypto";
import {
  enforceRateLimit,
  enforceSubmissionRateLimit,
  getAdminIdentity,
  getClientIp,
  insertAdminLog,
  requireAdmin
} from "../services/security";

function deriveExt(mimeType: string): string | null {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
  };
  return map[String(mimeType || "").toLowerCase()] || null;
}

function assertSafeKey(raw: string): string {
  const key = decodeURIComponent(String(raw || ""));
  if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes("..")) {
    badRequest("Invalid object key");
  }
  return key;
}

function queryInput(c: any): Record<string, unknown> {
  const params = new URL(c.req.url).searchParams;
  return Object.fromEntries(params.entries());
}

async function mapLostFoundRow(
  env: AppBindings["Bindings"],
  row: Record<string, any>,
  includeContact = false
): Promise<Record<string, unknown>> {
  const images = String(row.images_csv || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const contact = includeContact || Number(row.show_contact) === 1 ? await decryptText(env, row.contact_email_encrypted) : null;

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    county: row.county,
    state_code: row.state_code,
    status: row.status,
    show_contact: Number(row.show_contact) === 1,
    contact_email: contact,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    is_resolved: Number(row.is_resolved) === 1,
    resolved_at: row.resolved_at,
    resolved_note: row.resolved_note,
    expires_at: row.expires_at,
    moderation_note: row.moderation_note,
    images
  };
}

export function registerLostFoundRoutes(app: Hono<AppBindings>): void {
  app.get("/api/uploads/lost-found/:key{.+}", async (c) => {
    const key = assertSafeKey(c.req.param("key"));
    const object = await c.env.ky_news_media.get(`lost-found/${key}`);
    if (!object) notFound("Image not found");

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    if (!headers.has("cache-control")) {
      headers.set("cache-control", "public, max-age=604800");
    }

    return new Response(object.body, { headers });
  });

  const UploadUrlBody = z.object({
    filename: z.string().min(1).max(180),
    mimeType: z.string().min(3).max(80)
  });

  app.post("/api/uploads/lost-found-url", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = UploadUrlBody.safeParse(body || {});
    if (!parsed.success) badRequest("Invalid payload");

    const ext = deriveExt(parsed.data.mimeType);
    if (!ext) badRequest("Unsupported file type");

    const objectKey = `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.${ext}`;

    return c.json({
      objectKey,
      uploadUrl: `/api/uploads/lost-found/${encodeURIComponent(objectKey)}`,
      method: "PUT",
      headers: {
        "content-type": parsed.data.mimeType
      },
      maxBytes: 8 * 1024 * 1024
    });
  });

  app.put("/api/uploads/lost-found/:key{.+}", async (c) => {
    const key = assertSafeKey(c.req.param("key"));

    const contentType = (c.req.header("content-type") || "application/octet-stream").toLowerCase();
    const ext = deriveExt(contentType);
    if (!ext) badRequest("Unsupported file type");

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) {
      badRequest("File too large");
    }

    await c.env.ky_news_media.put(`lost-found/${key}`, bytes, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=604800"
      },
      customMetadata: {
        key,
        uploaded_at: new Date().toISOString()
      }
    });

    return c.json({ ok: true, objectKey: key, bytes: bytes.length });
  });

  const ListQuery = z.object({
    type: z.enum(LOST_FOUND_TYPES).optional(),
    county: z.string().min(2).max(80).optional(),
    status: z.enum(LOST_FOUND_STATUSES).default("published"),
    limit: z.coerce.number().min(1).max(100).default(40)
  });

  app.get("/api/lost-found", async (c) => {
    const parsed = ListQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const admin = getAdminIdentity(c);
    const where = ["datetime(p.expires_at) > datetime('now')"];
    const binds: unknown[] = [];

    if (!admin && parsed.data.status !== "published") unauthorized("Only published lost-and-found posts are public");

    if (parsed.data.status === "published") {
      where.push("p.status = 'approved'");
      where.push("COALESCE(p.is_resolved, 0) = 0");
    } else if (parsed.data.status === "resolved") {
      where.push("p.status = 'approved'");
      where.push("COALESCE(p.is_resolved, 0) = 1");
    } else {
      where.push("p.status = ?");
      binds.push(parsed.data.status);
    }

    if (parsed.data.type) {
      where.push("p.type = ?");
      binds.push(parsed.data.type);
    }

    if (parsed.data.county) {
      where.push("p.county = ?");
      binds.push(normalizeCounty(parsed.data.county));
    }

    const rows = await d1All<Record<string, unknown>>(
      c.env.ky_news_db,
      `
      SELECT
        p.*,
        (
          SELECT group_concat(i.r2_key)
          FROM lost_found_images i
          WHERE i.post_id = p.id
        ) AS images_csv
      FROM lost_found_posts p
      WHERE ${where.join(" AND ")}
      ORDER BY p.submitted_at DESC
      LIMIT ?
      `,
      [...binds, parsed.data.limit]
    );

    const posts = await Promise.all(rows.map((r) => mapLostFoundRow(c.env, r, Boolean(admin))));
    c.header("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=120");
    return c.json({
      posts,
      status: parsed.data.status,
      county: parsed.data.county ? normalizeCounty(parsed.data.county) : null
    });
  });

  const SubmissionBody = z.object({
    type: z.enum(LOST_FOUND_TYPES),
    title: z.string().min(2).max(120),
    description: z.string().min(4).max(2000),
    county: z.string().min(2).max(80),
    state: z.string().length(2).default("KY"),
    contactEmail: z.string().email(),
    showContact: z.boolean().default(false),
    imageKeys: z.array(z.string().min(1).max(320)).max(5).default([]),
    turnstileToken: z.string().optional()
  });

  app.post("/api/lost-found/submissions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SubmissionBody.safeParse(body || {});
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid payload",
          details: parsed.error.flatten()
        },
        400
      );
    }

    if (c.env.REQUIRE_TURNSTILE === "1" && !parsed.data.turnstileToken) {
      badRequest("Turnstile token is required");
    }

    const ip = getClientIp(c);
    const allowed = await enforceSubmissionRateLimit(c.env, ip);
    if (!allowed) tooManyRequests("Rate limit exceeded. Try again later.");

    if (String(parsed.data.state).toUpperCase() !== "KY") {
      badRequest("Only KY submissions are accepted at this time");
    }

    const id = randomUUID();
    const county = normalizeCounty(parsed.data.county);
    const encryptedContact = await encryptText(c.env, parsed.data.contactEmail.trim().toLowerCase());
    const initialStatus = c.env.LOST_FOUND_AUTO_APPROVE === "1" ? "approved" : "pending";

    await d1Run(
      c.env.ky_news_db,
      `
      INSERT INTO lost_found_posts (
        id, type, title, description, county, state_code,
        contact_email_encrypted, show_contact, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'KY', ?, ?, ?, datetime('now', '+30 days'))
      `,
      [
        id,
        parsed.data.type,
        parsed.data.title.trim(),
        parsed.data.description.trim(),
        county,
        encryptedContact,
        parsed.data.showContact ? 1 : 0,
        initialStatus
      ]
    );

    if (initialStatus === "approved") {
      await d1Run(c.env.ky_news_db, "UPDATE lost_found_posts SET approved_at=datetime('now') WHERE id=?", [id]);
    }

    for (const imageKey of parsed.data.imageKeys) {
      await d1Run(c.env.ky_news_db, "INSERT INTO lost_found_images (id, post_id, r2_key) VALUES (?, ?, ?)", [
        randomUUID(),
        id,
        imageKey
      ]);
    }

    return c.json({ ok: true, id, status: initialStatus });
  });

  const ReportBody = z.object({
    reason: z.string().min(4).max(400)
  });

  app.post("/api/lost-found/:id/report", async (c) => {
    const id = String(c.req.param("id") || "");
    const body = await c.req.json().catch(() => null);
    const parsed = ReportBody.safeParse(body || {});
    if (!parsed.success) badRequest("Invalid payload");

    const exists = await d1First<{ id: string }>(c.env.ky_news_db, "SELECT id FROM lost_found_posts WHERE id=?", [id]);
    if (!exists) notFound("Post not found");

    const ipHash = await hashIp(getClientIp(c));
    await d1Run(
      c.env.ky_news_db,
      "INSERT INTO lost_found_reports (id, post_id, reason, reporter_ip_hash) VALUES (?, ?, ?, ?)",
      [randomUUID(), id, parsed.data.reason.trim(), ipHash]
    );

    return c.json({ ok: true });
  });

  const MarkFoundBody = z.object({
    contactEmail: z.string().email(),
    note: z.string().max(500).optional()
  });

  app.post("/api/lost-found/:id/mark-found", async (c) => {
    const id = String(c.req.param("id") || "");
    const body = await c.req.json().catch(() => null);
    const parsed = MarkFoundBody.safeParse(body || {});
    if (!parsed.success) badRequest("Invalid payload");

    const ip = getClientIp(c);
    const rl = await enforceRateLimit(c.env, `lf-mark-found:${ip}`, 12, 60 * 60);
    if (!rl.allowed) tooManyRequests("Rate limit exceeded. Try again later.");

    const post = await d1First<{
      id: string;
      type: string;
      status: string;
      is_resolved: number;
      contact_email_encrypted: string;
    }>(
      c.env.ky_news_db,
      `
      SELECT id, type, status, is_resolved, contact_email_encrypted
      FROM lost_found_posts
      WHERE id=? AND datetime(expires_at) > datetime('now')
      LIMIT 1
      `,
      [id]
    );
    if (!post) {
      const exists = await d1First<{ id: string }>(c.env.ky_news_db, "SELECT id FROM lost_found_posts WHERE id=?", [id]);
      if (!exists) notFound("Post not found");
      badRequest("This listing has expired");
    }

    if (post.type !== "lost" || post.status !== "approved") {
      badRequest("Only active lost posts can be marked found");
    }
    if (Number(post.is_resolved || 0) === 1) {
      return c.json({ ok: true, id, status: "resolved" });
    }

    const submittedEmail = parsed.data.contactEmail.trim().toLowerCase();
    const ownerEmail = String((await decryptText(c.env, post.contact_email_encrypted)) || "")
      .trim()
      .toLowerCase();
    if (!ownerEmail || ownerEmail !== submittedEmail) {
      unauthorized("Contact email verification failed");
    }

    const info = await d1Run(
      c.env.ky_news_db,
      `
      UPDATE lost_found_posts
      SET
        is_resolved=1,
        resolved_at=datetime('now'),
        resolved_note=?
      WHERE id=? AND status='approved' AND COALESCE(is_resolved, 0)=0
      `,
      [parsed.data.note || null, id]
    );

    const changed = Number((info.meta as any)?.changes || 0);
    if (!changed) {
      return c.json({ ok: true, id, status: "resolved" });
    }

    return c.json({ ok: true, id, status: "resolved" });
  });

  const AdminListQuery = z.object({
    status: z.enum(["pending", "approved", "rejected", "resolved", "all"]).default("pending"),
    limit: z.coerce.number().min(1).max(200).default(100)
  });

  app.get("/api/admin/lost-found", async (c) => {
    const admin = requireAdmin(c);
    const parsed = AdminListQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const where: string[] = [];
    const binds: unknown[] = [];

    if (parsed.data.status === "resolved") {
      where.push("p.status = 'approved'");
      where.push("COALESCE(p.is_resolved, 0) = 1");
    } else if (parsed.data.status !== "all") {
      where.push("p.status = ?");
      binds.push(parsed.data.status);
    }

    const rows = await d1All<Record<string, unknown>>(
      c.env.ky_news_db,
      `
      SELECT
        p.*,
        (
          SELECT group_concat(i.r2_key)
          FROM lost_found_images i
          WHERE i.post_id = p.id
        ) AS images_csv
      FROM lost_found_posts p
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY p.submitted_at DESC
      LIMIT ?
      `,
      [...binds, parsed.data.limit]
    );

    const posts = await Promise.all(rows.map((r) => mapLostFoundRow(c.env, r, true)));
    return c.json({ admin: admin.email, posts });
  });

  const ApproveBody = z.object({
    showContact: z.boolean().optional(),
    note: z.string().max(500).optional()
  });

  app.post("/api/admin/lost-found/:id/approve", async (c) => {
    const admin = requireAdmin(c);
    const id = String(c.req.param("id") || "");
    const body = await c.req.json().catch(() => null);
    const parsed = ApproveBody.safeParse(body || {});
    if (!parsed.success) badRequest("Invalid payload");

    const info = await d1Run(
      c.env.ky_news_db,
      `
      UPDATE lost_found_posts
      SET
        status='approved',
        approved_at=datetime('now'),
        rejected_at=NULL,
        show_contact=COALESCE(?, show_contact),
        moderation_note=?
      WHERE id=? AND status='pending'
      `,
      [parsed.data.showContact == null ? null : parsed.data.showContact ? 1 : 0, parsed.data.note || null, id]
    );

    const changed = Number((info.meta as any)?.changes || 0);
    if (!changed) notFound("Pending post not found");

    await insertAdminLog(c.env, admin.email, "lost_found.approve", "lost_found_post", id, parsed.data);
    return c.json({ ok: true, id, status: "approved" });
  });

  const RejectBody = z.object({
    reason: z.string().min(3).max(500)
  });

  app.post("/api/admin/lost-found/:id/reject", async (c) => {
    const admin = requireAdmin(c);
    const id = String(c.req.param("id") || "");
    const body = await c.req.json().catch(() => null);
    const parsed = RejectBody.safeParse(body || {});
    if (!parsed.success) badRequest("Invalid payload");

    const info = await d1Run(
      c.env.ky_news_db,
      `
      UPDATE lost_found_posts
      SET
        status='rejected',
        rejected_at=datetime('now'),
        moderation_note=?
      WHERE id=? AND status='pending'
      `,
      [parsed.data.reason.trim(), id]
    );

    const changed = Number((info.meta as any)?.changes || 0);
    if (!changed) notFound("Pending post not found");

    await insertAdminLog(c.env, admin.email, "lost_found.reject", "lost_found_post", id, parsed.data);
    return c.json({ ok: true, id, status: "rejected" });
  });

  app.delete("/api/admin/lost-found/:id", async (c) => {
    const admin = requireAdmin(c);
    const id = String(c.req.param("id") || "");

    const row = await d1First<{ id: string; images_csv: string | null }>(
      c.env.ky_news_db,
      `
      SELECT
        p.id,
        (
          SELECT group_concat(i.r2_key)
          FROM lost_found_images i
          WHERE i.post_id = p.id
        ) AS images_csv
      FROM lost_found_posts p
      WHERE p.id=?
      LIMIT 1
      `,
      [id]
    );
    if (!row) notFound("Post not found");

    const imageKeys = String(row.images_csv || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    await d1Run(c.env.ky_news_db, "DELETE FROM lost_found_images WHERE post_id=?", [id]);
    await d1Run(c.env.ky_news_db, "DELETE FROM lost_found_reports WHERE post_id=?", [id]);
    await d1Run(c.env.ky_news_db, "DELETE FROM lost_found_posts WHERE id=?", [id]);

    await Promise.all(
      imageKeys.map(async (key) => {
        try {
          await c.env.ky_news_media.delete(`lost-found/${key}`);
        } catch {
          // Ignore media delete failures; DB record is source of truth for visibility.
        }
      })
    );

    await insertAdminLog(c.env, admin.email, "lost_found.delete", "lost_found_post", id, {
      deleted_images: imageKeys.length
    });

    return c.json({ ok: true, id, deletedImages: imageKeys.length });
  });
}
