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
const LOST_FOUND_STATUSES = ["pending", "approved", "rejected", "published", "resolved"];
const COMMENT_URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const COMMENT_MAX_URLS = 1;
const COMMENT_RATE_LIMIT = 8;
const COMMENT_RATE_WINDOW_MS = 60 * 60 * 1000;
const MARK_FOUND_RATE_LIMIT = 12;
const MARK_FOUND_RATE_WINDOW_MS = 60 * 60 * 1000;
const COMMENT_BLOCKLIST = [
  /\bfuck(?:ing|ed|er|s)?\b/i,
  /\bshit(?:ty|ting|ted|s)?\b/i,
  /\basshole(?:s)?\b/i,
  /\bbitch(?:es|y)?\b/i,
  /\bbastard(?:s)?\b/i,
  /\bkill\s+yourself\b/i,
  /\bi\s+will\s+kill\s+you\b/i
];
const commentRate = new Map();
const markFoundRate = new Map();

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
    is_resolved: Number(row.is_resolved) === 1,
    resolved_at: row.resolved_at,
    resolved_note: row.resolved_note,
    comment_count: Number(row.comment_count || 0),
    expires_at: row.expires_at,
    moderation_note: row.moderation_note,
    images
  };
}

function mapCommentRow(row) {
  return {
    id: row.id,
    post_id: row.post_id,
    name: row.commenter_name,
    comment: row.comment_text,
    created_at: row.created_at
  };
}

function mapAdminCommentRow(row) {
  return {
    id: row.id,
    post_id: row.post_id,
    post_title: row.post_title || null,
    name: row.commenter_name,
    comment: row.comment_text,
    created_at: row.created_at,
    commenter_email_hash: row.commenter_email_hash,
    commenter_ip_hash: row.commenter_ip_hash
  };
}

function mapCommentBanRow(row) {
  return {
    id: row.id,
    target_type: row.target_type,
    reason: row.reason || null,
    banned_by_email: row.banned_by_email,
    source_comment_id: row.source_comment_id || null,
    created_at: row.created_at
  };
}

function findLostFoundCommentBan(db, emailHash, ipHash) {
  return db
    .prepare(
      `
      SELECT id, target_type, reason
      FROM lost_found_comment_bans
      WHERE (target_type='email' AND target_hash=@emailHash)
         OR (target_type='ip' AND target_hash=@ipHash)
      ORDER BY created_at DESC
      LIMIT 1
      `
    )
    .get({ emailHash, ipHash });
}

function normalizeCommentText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function countCommentUrls(text) {
  const matches = String(text || "").match(COMMENT_URL_RE);
  return matches ? matches.length : 0;
}

function hasBlockedCommentLanguage(text) {
  const value = String(text || "");
  return COMMENT_BLOCKLIST.some((re) => re.test(value));
}

function enforceCommentRateLimit(ip) {
  const key = String(ip || "unknown");
  const now = Date.now();
  const existing = commentRate.get(key) || [];
  const next = existing.filter((ts) => now - ts < COMMENT_RATE_WINDOW_MS);
  if (next.length >= COMMENT_RATE_LIMIT) {
    commentRate.set(key, next);
    return false;
  }
  next.push(now);
  commentRate.set(key, next);
  return true;
}

function enforceMarkFoundRateLimit(ip) {
  const key = String(ip || "unknown");
  const now = Date.now();
  const existing = markFoundRate.get(key) || [];
  const next = existing.filter((ts) => now - ts < MARK_FOUND_RATE_WINDOW_MS);
  if (next.length >= MARK_FOUND_RATE_LIMIT) {
    markFoundRate.set(key, next);
    return false;
  }
  next.push(now);
  markFoundRate.set(key, next);
  return true;
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

      if (!admin && parsed.data.status !== "published") {
        return app.httpErrors.unauthorized("Only published lost-and-found posts are public");
      }

      if (parsed.data.status === "published") {
        where.push("p.status = 'approved'");
        where.push("COALESCE(p.is_resolved, 0) = 0");
      } else if (parsed.data.status === "resolved") {
        where.push("p.status = 'approved'");
        where.push("COALESCE(p.is_resolved, 0) = 1");
      } else {
        where.push("p.status = @status");
        params.status = parsed.data.status;
      }

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
            ) AS images_csv,
            (
              SELECT COUNT(1)
              FROM lost_found_comments c
              WHERE c.post_id = p.id
            ) AS comment_count
          FROM lost_found_posts p
          WHERE ${where.join(" AND ")}
          ORDER BY p.submitted_at DESC
          LIMIT @limit
        `
        )
        .all(params);

      return {
        posts: rows.map((r) => mapLostFoundRow(r, { includeContact: Boolean(admin) })),
        status: parsed.data.status,
        county: parsed.data.county ? normalizeCounty(parsed.data.county) : null
      };
    } finally {
      db.close();
    }
  });

  const LostFoundCommentListQuery = z.object({
    limit: z.coerce.number().min(1).max(200).default(80)
  });

  app.get("/api/lost-found/:id/comments", async (req) => {
    const id = String(req.params?.id || "");
    const parsed = LostFoundCommentListQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const db = openDb();
    try {
      ensureSchema(db);
      const post = db
        .prepare(
          `
          SELECT id
          FROM lost_found_posts
          WHERE id=? AND status='approved' AND datetime(expires_at) > datetime('now')
          LIMIT 1
          `
        )
        .get(id);
      if (!post) return app.httpErrors.notFound("Post not found");

      const rows = db
        .prepare(
          `
          SELECT id, post_id, commenter_name, comment_text, created_at
          FROM lost_found_comments
          WHERE post_id=@postId
          ORDER BY created_at ASC
          LIMIT @limit
          `
        )
        .all({ postId: id, limit: parsed.data.limit });

      return { comments: rows.map((row) => mapCommentRow(row)) };
    } finally {
      db.close();
    }
  });

  const LostFoundCommentBody = z.object({
    name: z.string().min(2).max(80),
    email: z.string().email(),
    comment: z.string().min(2).max(1500),
    acceptTerms: z.literal(true)
  });

  app.post("/api/lost-found/:id/comments", async (req) => {
    const id = String(req.params?.id || "");
    const parsed = LostFoundCommentBody.safeParse(req.body ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");

    const email = parsed.data.email.trim().toLowerCase();
    const emailHash = hashIp(email);
    const ipHash = hashIp(req.ip);

    if (!enforceCommentRateLimit(req.ip)) {
      return app.httpErrors.tooManyRequests("Comment rate limit exceeded. Try again later.");
    }

    const name = normalizeCommentText(parsed.data.name);
    const comment = normalizeCommentText(parsed.data.comment);
    if (!name || !comment) {
      return app.httpErrors.badRequest("Name and comment are required");
    }
    if (hasBlockedCommentLanguage(name) || hasBlockedCommentLanguage(comment)) {
      return app.httpErrors.badRequest("Comment violates the community policy.");
    }

    const urlCount = countCommentUrls(comment);
    if (urlCount > COMMENT_MAX_URLS) {
      return app.httpErrors.badRequest(`Comments are limited to ${COMMENT_MAX_URLS} URL.`);
    }

    const db = openDb();
    try {
      ensureSchema(db);
      const ban = findLostFoundCommentBan(db, emailHash, ipHash);
      if (ban) return app.httpErrors.forbidden("You are not allowed to comment at this time.");

      const post = db
        .prepare(
          `
          SELECT id
          FROM lost_found_posts
          WHERE id=? AND status='approved' AND datetime(expires_at) > datetime('now')
          LIMIT 1
          `
        )
        .get(id);
      if (!post) return app.httpErrors.notFound("Post not found");

      const commentId = randomUUID();
      db.prepare(
        `
        INSERT INTO lost_found_comments (
          id, post_id, commenter_name, commenter_email_encrypted, commenter_email_hash,
          comment_text, url_count, commenter_ip_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(commentId, id, name, encryptText(email), emailHash, comment, urlCount, ipHash);

      const row = db
        .prepare(
          `
          SELECT id, post_id, commenter_name, comment_text, created_at
          FROM lost_found_comments
          WHERE id=?
          LIMIT 1
          `
        )
        .get(commentId);
      return { ok: true, comment: mapCommentRow(row) };
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

    const contactEmail = parsed.data.contactEmail.trim().toLowerCase();
    const emailHash = hashIp(contactEmail);
    const ipHash = hashIp(req.ip);

    if (!enforceSubmissionRateLimit(req.ip)) {
      return app.httpErrors.tooManyRequests("Rate limit exceeded. Try again later.");
    }

    if (String(parsed.data.state).toUpperCase() !== "KY") {
      return app.httpErrors.badRequest("Only KY submissions are accepted at this time");
    }

    const db = openDb();
    try {
      ensureSchema(db);
      const ban = findLostFoundCommentBan(db, emailHash, ipHash);
      if (ban) return app.httpErrors.forbidden("You are not allowed to submit listings at this time.");

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
        contact: encryptText(contactEmail),
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

  const LostFoundMarkFoundBody = z.object({
    contactEmail: z.string().email(),
    note: z.string().max(500).optional()
  });

  app.post("/api/lost-found/:id/mark-found", async (req) => {
    const id = String(req.params?.id || "");
    const parsed = LostFoundMarkFoundBody.safeParse(req.body ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");

    if (!enforceMarkFoundRateLimit(req.ip)) {
      return app.httpErrors.tooManyRequests("Rate limit exceeded. Try again later.");
    }

    const db = openDb();
    try {
      ensureSchema(db);
      const post = db
        .prepare(
          `
          SELECT id, type, status, is_resolved, contact_email_encrypted
          FROM lost_found_posts
          WHERE id=? AND datetime(expires_at) > datetime('now')
          LIMIT 1
          `
        )
        .get(id);

      if (!post) {
        const exists = db.prepare("SELECT id FROM lost_found_posts WHERE id=?").get(id);
        if (!exists) return app.httpErrors.notFound("Post not found");
        return app.httpErrors.badRequest("This listing has expired");
      }

      if (post.type !== "lost" || post.status !== "approved") {
        return app.httpErrors.badRequest("Only active lost posts can be marked found");
      }
      if (Number(post.is_resolved || 0) === 1) {
        return { ok: true, id, status: "resolved" };
      }

      const submittedEmail = parsed.data.contactEmail.trim().toLowerCase();
      const ownerEmail = String(decryptText(post.contact_email_encrypted) || "")
        .trim()
        .toLowerCase();
      if (!ownerEmail || ownerEmail !== submittedEmail) {
        return app.httpErrors.unauthorized("Contact email verification failed");
      }

      const info = db
        .prepare(
          `
          UPDATE lost_found_posts
          SET
            is_resolved=1,
            resolved_at=datetime('now'),
            resolved_note=?
          WHERE id=? AND status='approved' AND COALESCE(is_resolved, 0)=0
          `
        )
        .run(parsed.data.note || null, id);

      if (!info.changes) {
        return { ok: true, id, status: "resolved" };
      }
      return { ok: true, id, status: "resolved" };
    } finally {
      db.close();
    }
  });

  const AdminLostFoundQuery = z.object({
    status: z.enum(["pending", "approved", "rejected", "resolved", "all"]).default("pending"),
    limit: z.coerce.number().min(1).max(200).default(100)
  });
  const AdminCommentListQuery = z.object({
    postId: z.string().min(1).optional(),
    limit: z.coerce.number().min(1).max(300).default(200)
  });
  const AdminBanBody = z.object({
    banUser: z.boolean().default(true),
    banIp: z.boolean().default(true),
    reason: z.string().max(300).optional()
  });
  const AdminBanListQuery = z.object({
    limit: z.coerce.number().min(1).max(300).default(200)
  });

  app.get("/api/admin/lost-found", async (req) => {
    const admin = requireAdmin(app, req);
    const parsed = AdminLostFoundQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const db = openDb();
    try {
      ensureSchema(db);
      const where = [];
      const params = { limit: parsed.data.limit };

      if (parsed.data.status === "resolved") {
        where.push("p.status = 'approved'");
        where.push("COALESCE(p.is_resolved, 0) = 1");
      } else if (parsed.data.status !== "all") {
        where.push("p.status = @status");
        params.status = parsed.data.status;
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
            ) AS images_csv,
            (
              SELECT COUNT(1)
              FROM lost_found_comments c
              WHERE c.post_id = p.id
            ) AS comment_count
          FROM lost_found_posts p
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY p.submitted_at DESC
          LIMIT @limit
        `
        )
        .all(params);

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

  app.delete("/api/admin/lost-found/:id", async (req) => {
    const admin = requireAdmin(app, req);
    const id = String(req.params?.id || "");

    const db = openDb();
    try {
      ensureSchema(db);
      const row = db
        .prepare(
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
          `
        )
        .get(id);
      if (!row) return app.httpErrors.notFound("Post not found");

      const imageKeys = String(row.images_csv || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

      db.prepare("DELETE FROM lost_found_images WHERE post_id=?").run(id);
      db.prepare("DELETE FROM lost_found_reports WHERE post_id=?").run(id);
      db.prepare("DELETE FROM lost_found_comments WHERE post_id=?").run(id);
      db.prepare("DELETE FROM lost_found_posts WHERE id=?").run(id);

      let deletedImages = 0;
      for (const key of imageKeys) {
        try {
          await fs.unlink(path.join(uploadDir, key));
          deletedImages += 1;
        } catch {
          // ignore missing local files
        }
      }

      insertAdminLog(db, admin.email, "lost_found.delete", "lost_found_post", id, {
        deleted_images: deletedImages
      });
      return { ok: true, id, deletedImages };
    } finally {
      db.close();
    }
  });

  app.get("/api/admin/lost-found/comments", async (req) => {
    requireAdmin(app, req);
    const parsed = AdminCommentListQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const db = openDb();
    try {
      ensureSchema(db);
      const where = [];
      const params = { limit: parsed.data.limit };
      if (parsed.data.postId) {
        where.push("c.post_id = @postId");
        params.postId = parsed.data.postId;
      }

      const rows = db
        .prepare(
          `
          SELECT
            c.id,
            c.post_id,
            c.commenter_name,
            c.comment_text,
            c.commenter_email_hash,
            c.commenter_ip_hash,
            c.created_at,
            p.title AS post_title
          FROM lost_found_comments c
          JOIN lost_found_posts p ON p.id = c.post_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY c.created_at DESC
          LIMIT @limit
          `
        )
        .all(params);

      return { comments: rows.map((row) => mapAdminCommentRow(row)) };
    } finally {
      db.close();
    }
  });

  app.post("/api/admin/lost-found/comments/:commentId/ban", async (req) => {
    const admin = requireAdmin(app, req);
    const commentId = String(req.params?.commentId || "");
    const parsed = AdminBanBody.safeParse(req.body ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid payload");
    if (!parsed.data.banUser && !parsed.data.banIp) {
      return app.httpErrors.badRequest("At least one ban target is required");
    }

    const db = openDb();
    try {
      ensureSchema(db);
      const comment = db
        .prepare(
          `
          SELECT id, post_id, commenter_email_hash, commenter_ip_hash
          FROM lost_found_comments
          WHERE id=?
          LIMIT 1
          `
        )
        .get(commentId);
      if (!comment) return app.httpErrors.notFound("Comment not found");

      const targets = [];
      if (parsed.data.banUser && String(comment.commenter_email_hash || "").trim()) {
        targets.push({ targetType: "email", targetHash: String(comment.commenter_email_hash) });
      }
      if (parsed.data.banIp && String(comment.commenter_ip_hash || "").trim()) {
        targets.push({ targetType: "ip", targetHash: String(comment.commenter_ip_hash) });
      }
      if (!targets.length) return app.httpErrors.badRequest("Unable to derive ban target from this comment");

      const reason = parsed.data.reason?.trim() || null;
      const upsert = db.prepare(
        `
        INSERT INTO lost_found_comment_bans (
          id, target_type, target_hash, reason, banned_by_email, source_comment_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_type, target_hash) DO UPDATE SET
          reason=excluded.reason,
          banned_by_email=excluded.banned_by_email,
          source_comment_id=excluded.source_comment_id,
          created_at=datetime('now')
        `
      );
      for (const target of targets) {
        upsert.run(randomUUID(), target.targetType, target.targetHash, reason, admin.email, commentId);
      }

      insertAdminLog(db, admin.email, "lost_found.comment.ban", "lost_found_comment", commentId, {
        banUser: parsed.data.banUser,
        banIp: parsed.data.banIp,
        reason
      });
      return { ok: true, id: commentId, bansApplied: targets.length };
    } finally {
      db.close();
    }
  });

  app.get("/api/admin/lost-found/bans", async (req) => {
    requireAdmin(app, req);
    const parsed = AdminBanListQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const db = openDb();
    try {
      ensureSchema(db);
      const rows = db
        .prepare(
          `
          SELECT id, target_type, reason, banned_by_email, source_comment_id, created_at
          FROM lost_found_comment_bans
          ORDER BY created_at DESC
          LIMIT @limit
          `
        )
        .all({ limit: parsed.data.limit });

      return { bans: rows.map((row) => mapCommentBanRow(row)) };
    } finally {
      db.close();
    }
  });

  app.delete("/api/admin/lost-found/bans/:banId", async (req) => {
    const admin = requireAdmin(app, req);
    const banId = String(req.params?.banId || "");

    const db = openDb();
    try {
      ensureSchema(db);
      const row = db
        .prepare("SELECT id, target_type, source_comment_id FROM lost_found_comment_bans WHERE id=? LIMIT 1")
        .get(banId);
      if (!row) return app.httpErrors.notFound("Ban not found");

      db.prepare("DELETE FROM lost_found_comment_bans WHERE id=?").run(banId);
      insertAdminLog(db, admin.email, "lost_found.comment.unban", "lost_found_comment_ban", banId, {
        target_type: row.target_type,
        source_comment_id: row.source_comment_id
      });
      return { ok: true, id: banId };
    } finally {
      db.close();
    }
  });

  app.delete("/api/admin/lost-found/comments/:commentId", async (req) => {
    const admin = requireAdmin(app, req);
    const commentId = String(req.params?.commentId || "");

    const db = openDb();
    try {
      ensureSchema(db);
      const row = db.prepare("SELECT id, post_id FROM lost_found_comments WHERE id=? LIMIT 1").get(commentId);
      if (!row) return app.httpErrors.notFound("Comment not found");

      db.prepare("DELETE FROM lost_found_comments WHERE id=?").run(commentId);
      insertAdminLog(db, admin.email, "lost_found.comment.delete", "lost_found_comment", commentId, {
        post_id: row.post_id
      });
      return { ok: true, id: commentId };
    } finally {
      db.close();
    }
  });
}
