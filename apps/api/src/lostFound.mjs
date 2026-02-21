import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureSchema } from "./schema.mjs";
import { normalizeCounty } from "./search.mjs";
import {
  decryptText,
  encryptText,
  enforceSubmissionRateLimit,
  getAdminIdentity,
  hashIp,
  insertAdminLog,
  requireAdmin
} from "./security.mjs";

const LOST_FOUND_TYPES = ["lost", "found"];
const LOST_FOUND_STATUSES = ["pending", "approved", "rejected", "published"];

function deriveExt(mimeType) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  };
  return map[String(mimeType || "").toLowerCase()] || null;
}

function mapLostFoundRow(row, { includeContact = false } = {}) {
  const images = String(row.images_csv || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const contact_email = includeContact || Number(row.show_contact) === 1 ? decryptText(row.contact_email_encrypted) : null;

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    county: row.county,
    state_code: row.state_code,
    status: row.status,
    show_contact: Number(row.show_contact) === 1,
    contact_email,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    expires_at: row.expires_at,
    moderation_note: row.moderation_note,
    images
  };
}

export function registerLostFoundRoutes(app, openDb, uploadDir) {
  app.get("/api/uploads/lost-found/:key", async (req, reply) => {
    const key = decodeURIComponent(String(req.params?.key || ""));
    if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes("..")) {
      return app.httpErrors.badRequest("Invalid object key");
    }

    const filePath = path.join(uploadDir, key);
    try {
      const buf = await fs.readFile(filePath);
      const lower = key.toLowerCase();
      const type = lower.endsWith(".png")
        ? "image/png"
        : lower.endsWith(".webp")
          ? "image/webp"
          : lower.endsWith(".gif")
            ? "image/gif"
            : "image/jpeg";
      reply.header("content-type", type);
      return reply.send(buf);
    } catch {
      return app.httpErrors.notFound("Image not found");
    }
  });

  const UploadUrlBody = z.object({
    filename: z.string().min(1).max(180),
    mimeType: z.string().min(3).max(80)
  });

  app.post("/api/uploads/lost-found-url", async (req) => {
    const parsed = UploadUrlBody.safeParse(req.body ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");

    const ext = deriveExt(parsed.data.mimeType);
    if (!ext) return app.httpErrors.badRequest("Unsupported file type");

    const objectKey = `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.${ext}`;
    return {
      objectKey,
      uploadUrl: `/api/uploads/lost-found/${encodeURIComponent(objectKey)}`,
      method: "PUT",
      headers: {
        "content-type": parsed.data.mimeType
      },
      maxBytes: 8 * 1024 * 1024
    };
  });

  app.put("/api/uploads/lost-found/:key", async (req) => {
    const key = decodeURIComponent(String(req.params?.key || ""));
    if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes("..")) {
      return app.httpErrors.badRequest("Invalid object key");
    }

    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      return app.httpErrors.badRequest("Binary body required");
    }

    if (body.length > 8 * 1024 * 1024) {
      return app.httpErrors.badRequest("File too large");
    }

    const filePath = path.join(uploadDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);

    return { ok: true, objectKey: key, bytes: body.length };
  });

  const LostFoundListQuery = z.object({
    type: z.enum(LOST_FOUND_TYPES).optional(),
    county: z.string().min(2).max(80).optional(),
    status: z.enum(LOST_FOUND_STATUSES).default("published"),
    limit: z.coerce.number().min(1).max(100).default(40)
  });

  app.get("/api/lost-found", async (req) => {
    const parsed = LostFoundListQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const admin = getAdminIdentity(req);
    const db = openDb();

    try {
      ensureSchema(db);

      const where = ["datetime(p.expires_at) > datetime('now')"];
      const params = { limit: parsed.data.limit };

      const status = parsed.data.status === "published" ? "approved" : parsed.data.status;
      if (!admin && status !== "approved") {
        return app.httpErrors.unauthorized("Only published lost-and-found posts are public");
      }

      where.push("p.status = @status");
      params.status = status;

      if (parsed.data.type) {
        where.push("p.type = @type");
        params.type = parsed.data.type;
      }

      if (parsed.data.county) {
        where.push("p.county = @county");
        params.county = normalizeCounty(parsed.data.county);
      }

      const rows = db
        .prepare(
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
          LIMIT @limit
        `
        )
        .all(params);

      return {
        posts: rows.map((r) => mapLostFoundRow(r, { includeContact: Boolean(admin) })),
        status,
        county: parsed.data.county ? normalizeCounty(parsed.data.county) : null
      };
    } finally {
      db.close();
    }
  });

  const LostFoundSubmissionBody = z.object({
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

  app.post("/api/lost-found/submissions", async (req) => {
    const parsed = LostFoundSubmissionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return app.httpErrors.badRequest({
        error: "Invalid payload",
        details: parsed.error.flatten()
      });
    }

    if (process.env.REQUIRE_TURNSTILE === "1" && !parsed.data.turnstileToken) {
      return app.httpErrors.badRequest("Turnstile token is required");
    }

    if (!enforceSubmissionRateLimit(req.ip)) {
      return app.httpErrors.tooManyRequests("Rate limit exceeded. Try again later.");
    }

    if (String(parsed.data.state).toUpperCase() !== "KY") {
      return app.httpErrors.badRequest("Only KY submissions are accepted at this time");
    }

    const db = openDb();
    try {
      ensureSchema(db);

      const id = randomUUID();
      const county = normalizeCounty(parsed.data.county);

      db.prepare(
        `
        INSERT INTO lost_found_posts (
          id, type, title, description, county, state_code,
          contact_email_encrypted, show_contact, status, expires_at
        ) VALUES (
          @id, @type, @title, @description, @county, 'KY',
          @contact, @showContact, 'pending', datetime('now', '+30 days')
        )
      `
      ).run({
        id,
        type: parsed.data.type,
        title: parsed.data.title.trim(),
        description: parsed.data.description.trim(),
        county,
        contact: encryptText(parsed.data.contactEmail.trim().toLowerCase()),
        showContact: parsed.data.showContact ? 1 : 0
      });

      const insImage = db.prepare("INSERT INTO lost_found_images (id, post_id, r2_key) VALUES (?, ?, ?)");
      for (const imageKey of parsed.data.imageKeys) {
        insImage.run(randomUUID(), id, imageKey);
      }

      return { ok: true, id, status: "pending" };
    } finally {
      db.close();
    }
  });

  const LostFoundReportBody = z.object({
    reason: z.string().min(4).max(400)
  });

  app.post("/api/lost-found/:id/report", async (req) => {
    const id = String(req.params?.id || "");
    const parsed = LostFoundReportBody.safeParse(req.body ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");

    const db = openDb();
    try {
      ensureSchema(db);

      const exists = db.prepare("SELECT id FROM lost_found_posts WHERE id=?").get(id);
      if (!exists) return app.httpErrors.notFound("Post not found");

      db.prepare(
        "INSERT INTO lost_found_reports (id, post_id, reason, reporter_ip_hash) VALUES (?, ?, ?, ?)"
      ).run(randomUUID(), id, parsed.data.reason.trim(), hashIp(req.ip));

      return { ok: true };
    } finally {
      db.close();
    }
  });

  const AdminLostFoundQuery = z.object({
    status: z.enum(["pending", "approved", "rejected"]).default("pending"),
    limit: z.coerce.number().min(1).max(200).default(100)
  });

  app.get("/api/admin/lost-found", async (req) => {
    const admin = requireAdmin(app, req);
    const parsed = AdminLostFoundQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const db = openDb();
    try {
      ensureSchema(db);

      const rows = db
        .prepare(
          `
          SELECT
            p.*,
            (
              SELECT group_concat(i.r2_key)
              FROM lost_found_images i
              WHERE i.post_id = p.id
            ) AS images_csv
          FROM lost_found_posts p
          WHERE p.status = @status
          ORDER BY p.submitted_at DESC
          LIMIT @limit
        `
        )
        .all({ status: parsed.data.status, limit: parsed.data.limit });

      return {
        admin: admin.email,
        posts: rows.map((r) => mapLostFoundRow(r, { includeContact: true }))
      };
    } finally {
      db.close();
    }
  });

  const ApproveBody = z.object({
    showContact: z.boolean().optional(),
    note: z.string().max(500).optional()
  });

  app.post("/api/admin/lost-found/:id/approve", async (req) => {
    const admin = requireAdmin(app, req);
    const id = String(req.params?.id || "");
    const parsed = ApproveBody.safeParse(req.body ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");

    const db = openDb();
    try {
      ensureSchema(db);

      const info = db
        .prepare(
          `
          UPDATE lost_found_posts
          SET
            status='approved',
            approved_at=datetime('now'),
            rejected_at=NULL,
            show_contact=COALESCE(@showContact, show_contact),
            moderation_note=@note
          WHERE id=@id AND status='pending'
        `
        )
        .run({
          id,
          showContact: parsed.data.showContact == null ? null : parsed.data.showContact ? 1 : 0,
          note: parsed.data.note || null
        });

      if (!info.changes) return app.httpErrors.notFound("Pending post not found");

      insertAdminLog(db, admin.email, "lost_found.approve", "lost_found_post", id, parsed.data);
      return { ok: true, id, status: "approved" };
    } finally {
      db.close();
    }
  });

  const RejectBody = z.object({
    reason: z.string().min(3).max(500)
  });

  app.post("/api/admin/lost-found/:id/reject", async (req) => {
    const admin = requireAdmin(app, req);
    const id = String(req.params?.id || "");
    const parsed = RejectBody.safeParse(req.body ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");

    const db = openDb();
    try {
      ensureSchema(db);

      const info = db
        .prepare(
          `
          UPDATE lost_found_posts
          SET
            status='rejected',
            rejected_at=datetime('now'),
            moderation_note=@reason
          WHERE id=@id AND status='pending'
        `
        )
        .run({ id, reason: parsed.data.reason.trim() });

      if (!info.changes) return app.httpErrors.notFound("Pending post not found");

      insertAdminLog(db, admin.email, "lost_found.reject", "lost_found_post", id, parsed.data);
      return { ok: true, id, status: "rejected" };
    } finally {
      db.close();
    }
  });
}
