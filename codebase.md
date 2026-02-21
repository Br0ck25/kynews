# .gitignore

```
node_modules
dist
.data
data/*.sqlite
data/*.sqlite-*
data/uploads/
.env

```

# API_DETAILS.md

```md
# API Details

Canonical API documentation:

- `docs/04_API_SPEC.md`
- Weather: `docs/07_WEATHER_SPEC.md`
- Lost and Found: `docs/08_LOST_FOUND_SPEC.md`

```

# apps\api\package.json

```json
{
  "name": "@feedly-clone/api",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "scripts": {
    "dev": "node --watch src/server.mjs"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.0",
    "better-sqlite3": "^11.0.0",
    "fastify": "^5.0.0",
    "zod": "^3.23.0",
    "@fastify/sensible": "^6.0.0"
  }
}
```

# apps\api\src\db.mjs

```mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");

function defaultDbPath() {
  return path.resolve(repoRoot, "data", "dev.sqlite");
}

const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : defaultDbPath();

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  return db;
}

```

# apps\api\src\lostFound.mjs

```mjs
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

```

# apps\api\src\schema.mjs

```mjs
export function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

export function ensureSchema(db) {
  if (!columnExists(db, "feeds", "region_scope")) {
    db.prepare("ALTER TABLE feeds ADD COLUMN region_scope TEXT NOT NULL DEFAULT 'ky'").run();
  }
  if (!columnExists(db, "feeds", "default_county")) {
    db.prepare("ALTER TABLE feeds ADD COLUMN default_county TEXT").run();
  }

  if (!columnExists(db, "items", "region_scope")) {
    db.prepare("ALTER TABLE items ADD COLUMN region_scope TEXT NOT NULL DEFAULT 'ky'").run();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS weather_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state_code TEXT NOT NULL,
      county TEXT NOT NULL,
      forecast_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_weather_forecasts_county ON weather_forecasts(state_code, county, fetched_at);

    CREATE TABLE IF NOT EXISTS weather_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT NOT NULL,
      state_code TEXT NOT NULL,
      county TEXT NOT NULL,
      severity TEXT,
      event TEXT,
      headline TEXT,
      starts_at TEXT,
      ends_at TEXT,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_weather_alerts_state_county ON weather_alerts(state_code, county, fetched_at);
    CREATE INDEX IF NOT EXISTS idx_weather_alerts_alert_id ON weather_alerts(alert_id);

    CREATE TABLE IF NOT EXISTS lost_found_posts (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('lost', 'found')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      county TEXT NOT NULL,
      state_code TEXT NOT NULL DEFAULT 'KY',
      contact_email_encrypted TEXT NOT NULL,
      show_contact INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      rejected_at TEXT,
      expires_at TEXT NOT NULL,
      moderation_note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_lost_found_posts_status ON lost_found_posts(status, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_lost_found_posts_county ON lost_found_posts(state_code, county, status);

    CREATE TABLE IF NOT EXISTS lost_found_images (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES lost_found_posts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_lost_found_images_post_id ON lost_found_images(post_id);

    CREATE TABLE IF NOT EXISTS lost_found_reports (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      reporter_ip_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES lost_found_posts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_lost_found_reports_post_id ON lost_found_reports(post_id, created_at);

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at);

    CREATE INDEX IF NOT EXISTS idx_items_region_scope ON items(region_scope);
    CREATE INDEX IF NOT EXISTS idx_feeds_region_scope ON feeds(region_scope);
  `);
}

```

# apps\api\src\search.mjs

```mjs
export function csvToArray(csv) {
  if (!csv) return [];
  return String(csv)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function mapItemRow(row) {
  const states = csvToArray(row.states_csv);
  const counties = csvToArray(row.counties_csv);
  const { states_csv, counties_csv, ...rest } = row;
  return { ...rest, states, counties };
}

export function escapeLike(input) {
  return String(input).replace(/[\\%_]/g, "\\$&");
}

export function parseSearchQuery(input) {
  const q = String(input || "");
  const tokens = [];
  let i = 0;

  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i])) i++;
    if (i >= q.length) break;

    let negated = false;
    if (q[i] === "-") {
      negated = true;
      i++;
      while (i < q.length && /\s/.test(q[i])) i++;
    }

    if (i >= q.length) break;

    let value = "";
    let quoted = false;
    if (q[i] === '"') {
      quoted = true;
      i++;
      const start = i;
      while (i < q.length && q[i] !== '"') i++;
      value = q.slice(start, i);
      if (i < q.length && q[i] === '"') i++;
    } else {
      const start = i;
      while (i < q.length && !/\s/.test(q[i])) i++;
      value = q.slice(start, i);
    }

    value = value.trim();
    if (!value) continue;

    if (!quoted && !negated) {
      const upper = value.toUpperCase();
      if (upper === "AND" || upper === "OR") {
        tokens.push({ kind: "op", op: upper });
        continue;
      }
    }

    tokens.push({ kind: "term", value, negated });
  }

  const groups = [{ include: [], exclude: [] }];
  for (const token of tokens) {
    const current = groups[groups.length - 1];
    if (token.kind === "op") {
      if (token.op === "OR") {
        if (current.include.length || current.exclude.length) groups.push({ include: [], exclude: [] });
      }
      continue;
    }

    if (token.negated) current.exclude.push(token.value);
    else current.include.push(token.value);
  }

  return groups.filter((g) => g.include.length || g.exclude.length);
}

export function buildSearchClause(rawQuery, params) {
  const searchableDoc = "LOWER(COALESCE(i.title, '') || ' ' || COALESCE(i.summary, '') || ' ' || COALESCE(i.content, ''))";
  const groups = parseSearchQuery(rawQuery);
  if (!groups.length) return "1=0";

  const orBlocks = groups.map((g, gIdx) => {
    const andParts = [];

    for (let i = 0; i < g.include.length; i++) {
      const key = `q_i_${gIdx}_${i}`;
      params[key] = `%${escapeLike(g.include[i].toLowerCase())}%`;
      andParts.push(`${searchableDoc} LIKE @${key} ESCAPE '\\'`);
    }

    for (let i = 0; i < g.exclude.length; i++) {
      const key = `q_x_${gIdx}_${i}`;
      params[key] = `%${escapeLike(g.exclude[i].toLowerCase())}%`;
      andParts.push(`${searchableDoc} NOT LIKE @${key} ESCAPE '\\'`);
    }

    if (!andParts.length) return null;
    return `(${andParts.join(" AND ")})`;
  });

  const filtered = orBlocks.filter(Boolean);
  if (!filtered.length) return "1=0";
  return `(${filtered.join(" OR ")})`;
}

export function normalizeCounty(county) {
  return String(county || "")
    .trim()
    .replace(/\s+county$/i, "")
    .replace(/\s+/g, " ");
}

export function isKy(stateCode) {
  return String(stateCode || "").toUpperCase() === "KY";
}

export function safeJsonParse(input, fallback) {
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

```

# apps\api\src\security.mjs

```mjs
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

const ENCRYPTION_KEY = createHash("sha256")
  .update(process.env.LOCAL_DATA_ENCRYPTION_KEY || "dev-only-change-me")
  .digest();

export function encryptText(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptText(cipherText) {
  if (!cipherText) return null;
  try {
    const data = Buffer.from(String(cipherText), "base64");
    if (data.length < 28) return null;
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function hashIp(ip) {
  return createHash("sha256").update(String(ip || "")).digest("hex");
}

const submissionRate = new Map();

function cleanupRateWindow() {
  const now = Date.now();
  for (const [key, list] of submissionRate.entries()) {
    const next = list.filter((ts) => now - ts < 60 * 60 * 1000);
    if (!next.length) submissionRate.delete(key);
    else submissionRate.set(key, next);
  }
}

export function enforceSubmissionRateLimit(ip) {
  cleanupRateWindow();
  const key = String(ip || "unknown");
  const now = Date.now();
  const list = submissionRate.get(key) || [];
  const next = list.filter((ts) => now - ts < 60 * 60 * 1000);
  if (next.length >= 5) return false;
  next.push(now);
  submissionRate.set(key, next);
  return true;
}

export function getAdminIdentity(req) {
  const cfEmail = req.headers["cf-access-authenticated-user-email"];
  if (cfEmail) {
    return { email: String(cfEmail), source: "cloudflare-access" };
  }

  const adminToken = process.env.ADMIN_TOKEN;
  const headerToken = req.headers["x-admin-token"];
  if (adminToken && headerToken && String(headerToken) === adminToken) {
    return { email: process.env.ADMIN_EMAIL || "local-admin", source: "admin-token" };
  }

  return null;
}

export function requireAdmin(app, req) {
  const identity = getAdminIdentity(req);
  if (!identity) {
    throw app.httpErrors.unauthorized("Admin authentication required");
  }
  return identity;
}

export function insertAdminLog(db, actorEmail, action, entityType, entityId, payload = null) {
  db.prepare(
    "INSERT INTO admin_audit_log (id, actor_email, action, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(randomUUID(), actorEmail, action, entityType, entityId, payload ? JSON.stringify(payload) : null);
}

```

# apps\api\src\server.mjs

```mjs
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
const PAID_SOURCE_DOMAINS = ["kentucky.com", "courier-journal.com", "bizjournals.com"];

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
    _fp: titleFingerprint(item.title),
    _canonicalUrl: canonicalUrl(item.url),
    _source: sourceHost(item.url),
    _sortTs: String(item.sort_ts || "")
  }));

  ranked.sort((a, b) => {
    if (a._isPaid !== b._isPaid) return a._isPaid ? 1 : -1;
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
  const trimmed = filtered.slice(0, limit);
  return trimmed.map(({ _isPaid, _fp, _canonicalUrl, _source, _sortTs, ...rest }) => rest);
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

```

# apps\api\src\weather.mjs

```mjs
import { z } from "zod";
import { ensureSchema } from "./schema.mjs";
import { normalizeCounty, safeJsonParse } from "./search.mjs";

const WEATHER_STATES = ["KY"];
const NWS_USER_AGENT = process.env.NWS_USER_AGENT || "EasternKentuckyNews/1.0 (local-dev@example.com)";
let kyZoneCache = { loadedAt: 0, zones: new Map() };

async function nwsFetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/geo+json",
      "User-Agent": NWS_USER_AGENT
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NWS request failed (${res.status}): ${body.slice(0, 240)}`);
  }

  return res.json();
}

async function getKyCountyZoneMap() {
  const now = Date.now();
  if (now - kyZoneCache.loadedAt < 6 * 60 * 60 * 1000 && kyZoneCache.zones.size) {
    return kyZoneCache.zones;
  }

  const zones = new Map();
  let nextUrl = "https://api.weather.gov/zones?type=county&area=KY";
  let guard = 0;

  while (nextUrl && guard < 10) {
    guard += 1;
    const payload = await nwsFetchJson(nextUrl);
    const features = Array.isArray(payload?.features) ? payload.features : [];

    for (const feature of features) {
      const props = feature?.properties || {};
      const zoneId = props.id;
      const zoneName = normalizeCounty(props.name || "");
      if (!zoneId || !zoneName) continue;
      zones.set(zoneName.toLowerCase(), zoneId);
    }

    nextUrl = payload?.pagination?.next || null;
  }

  kyZoneCache = { loadedAt: now, zones };
  return zones;
}

async function fetchCountyForecast(county) {
  const countyKey = normalizeCounty(county).toLowerCase();
  if (!countyKey) throw new Error("County is required");

  const zones = await getKyCountyZoneMap();
  const countyZoneId = zones.get(countyKey);
  if (!countyZoneId) throw new Error(`No NWS county zone found for ${county}`);

  const countyZone = await nwsFetchJson(`https://api.weather.gov/zones/county/${countyZoneId}`);
  const geometry = countyZone?.geometry;
  const centroid = getGeometryCentroid(geometry);
  if (!centroid) throw new Error(`No geometry centroid for county zone ${countyZoneId}`);

  const points = await nwsFetchJson(
    `https://api.weather.gov/points/${centroid.lat.toFixed(4)},${centroid.lon.toFixed(4)}`
  );
  const forecastUrl = String(points?.properties?.forecast || "");
  if (!forecastUrl) throw new Error(`No forecast URL returned for county zone ${countyZoneId}`);

  const forecastZoneUri = String(points?.properties?.forecastZone || "");
  const forecastZoneId = forecastZoneUri.split("/").filter(Boolean).pop() || countyZoneId;
  const payload = await nwsFetchJson(forecastUrl);
  const props = payload?.properties || {};
  const periodsRaw = Array.isArray(props.periods) ? props.periods : [];

  const periods = periodsRaw.slice(0, 14).map((p) => ({
    name: p.name,
    startTime: p.startTime,
    endTime: p.endTime,
    temperature: p.temperature,
    temperatureUnit: p.temperatureUnit,
    windSpeed: p.windSpeed,
    windDirection: p.windDirection,
    shortForecast: p.shortForecast,
    detailedForecast: p.detailedForecast,
    icon: p.icon
  }));

  return {
    state: "KY",
    county: normalizeCounty(county),
    zoneId: forecastZoneId,
    countyZoneId,
    updatedAt: props.updated || new Date().toISOString(),
    periods,
    source: "api.weather.gov"
  };
}

function getGeometryCentroid(geometry) {
  const points = [];

  if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return null;

  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) {
      for (const pair of ring) points.push(pair);
    }
  }

  if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) {
        for (const pair of ring) points.push(pair);
      }
    }
  }

  const valid = points.filter((pair) => Array.isArray(pair) && pair.length >= 2);
  if (!valid.length) return null;

  let lon = 0;
  let lat = 0;
  for (const pair of valid) {
    lon += Number(pair[0]);
    lat += Number(pair[1]);
  }

  return { lon: lon / valid.length, lat: lat / valid.length };
}

async function fetchCountyAlerts(stateCode, county) {
  const payload = await nwsFetchJson(`https://api.weather.gov/alerts/active?area=${encodeURIComponent(stateCode)}`);
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const countyFilter = county ? normalizeCounty(county).toLowerCase() : null;

  const alerts = [];
  for (const feature of features) {
    const props = feature?.properties || {};
    const areaDesc = String(props.areaDesc || "").toLowerCase();
    if (countyFilter && !areaDesc.includes(countyFilter)) continue;

    alerts.push({
      id: String(feature.id || props.id || ""),
      event: props.event || "Unknown",
      severity: props.severity || "Unknown",
      headline: props.headline || props.event || "Alert",
      description: props.description || "",
      instruction: props.instruction || "",
      starts_at: props.onset || props.effective || null,
      ends_at: props.ends || props.expires || null,
      sent_at: props.sent || null,
      status: props.status || null,
      url: props.url || null,
      area_desc: props.areaDesc || ""
    });
  }

  return alerts;
}

export function registerWeatherRoutes(app, openDb) {
  const WeatherForecastQuery = z.object({
    state: z.string().length(2).default("KY"),
    county: z.string().min(2).max(80)
  });

  app.get("/api/weather/forecast", async (req) => {
    const parsed = WeatherForecastQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const { state, county } = parsed.data;
    if (!WEATHER_STATES.includes(state.toUpperCase())) {
      return app.httpErrors.badRequest("Weather forecast currently supports KY only");
    }

    const normalizedCounty = normalizeCounty(county);
    const db = openDb();

    try {
      ensureSchema(db);

      const cached = db
        .prepare(
          `
          SELECT forecast_json, fetched_at, expires_at
          FROM weather_forecasts
          WHERE state_code=@stateCode AND county=@county
          ORDER BY fetched_at DESC
          LIMIT 1
        `
        )
        .get({ stateCode: "KY", county: normalizedCounty });

      const nowIso = new Date().toISOString();
      if (cached && cached.expires_at > nowIso) {
        return {
          ...safeJsonParse(cached.forecast_json, {}),
          fetchedAt: cached.fetched_at,
          expiresAt: cached.expires_at,
          cached: true
        };
      }

      const live = await fetchCountyForecast(normalizedCounty);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      db.prepare(
        "INSERT INTO weather_forecasts (state_code, county, forecast_json, expires_at) VALUES (?, ?, ?, ?)"
      ).run("KY", normalizedCounty, JSON.stringify(live), expiresAt);

      db.prepare("DELETE FROM weather_forecasts WHERE fetched_at < datetime('now', '-7 days')").run();

      return {
        ...live,
        fetchedAt: new Date().toISOString(),
        expiresAt,
        cached: false
      };
    } catch (err) {
      const fallback = db
        .prepare(
          `
          SELECT forecast_json, fetched_at, expires_at
          FROM weather_forecasts
          WHERE state_code=@stateCode AND county=@county
          ORDER BY fetched_at DESC
          LIMIT 1
        `
        )
        .get({ stateCode: "KY", county: normalizedCounty });

      if (fallback) {
        return {
          ...safeJsonParse(fallback.forecast_json, {}),
          fetchedAt: fallback.fetched_at,
          expiresAt: fallback.expires_at,
          cached: true,
          stale: true,
          warning: String(err?.message || err)
        };
      }

      throw app.httpErrors.badGateway(String(err?.message || err));
    } finally {
      db.close();
    }
  });

  const WeatherAlertsQuery = z.object({
    state: z.string().length(2).default("KY"),
    county: z.string().min(2).max(80).optional()
  });

  app.get("/api/weather/alerts", async (req) => {
    const parsed = WeatherAlertsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const { state, county } = parsed.data;
    const stateCode = state.toUpperCase();
    const normalizedCounty = county ? normalizeCounty(county) : "";

    if (!WEATHER_STATES.includes(stateCode)) {
      return app.httpErrors.badRequest("Weather alerts currently support KY only");
    }

    const db = openDb();
    try {
      ensureSchema(db);

      const liveAlerts = await fetchCountyAlerts(stateCode, normalizedCounty || null);

      db.prepare("DELETE FROM weather_alerts WHERE state_code=@stateCode AND county=@county").run({
        stateCode,
        county: normalizedCounty
      });

      const insert = db.prepare(
        `
        INSERT INTO weather_alerts (
          alert_id, state_code, county, severity, event, headline, starts_at, ends_at, raw_json
        ) VALUES (
          @alert_id, @state_code, @county, @severity, @event, @headline, @starts_at, @ends_at, @raw_json
        )
      `
      );

      for (const alert of liveAlerts) {
        insert.run({
          alert_id: alert.id,
          state_code: stateCode,
          county: normalizedCounty,
          severity: alert.severity,
          event: alert.event,
          headline: alert.headline,
          starts_at: alert.starts_at,
          ends_at: alert.ends_at,
          raw_json: JSON.stringify(alert)
        });
      }

      db.prepare("DELETE FROM weather_alerts WHERE fetched_at < datetime('now', '-48 hours')").run();

      return {
        state: stateCode,
        county: normalizedCounty || null,
        alerts: liveAlerts,
        fetchedAt: new Date().toISOString(),
        source: "api.weather.gov"
      };
    } catch (err) {
      const rows = db
        .prepare(
          `
          SELECT raw_json
          FROM weather_alerts
          WHERE state_code=@stateCode AND county=@county
          ORDER BY fetched_at DESC
          LIMIT 100
        `
        )
        .all({ stateCode, county: normalizedCounty });

      if (rows.length) {
        return {
          state: stateCode,
          county: normalizedCounty || null,
          alerts: rows.map((r) => safeJsonParse(r.raw_json, null)).filter(Boolean),
          stale: true,
          warning: String(err?.message || err)
        };
      }

      throw app.httpErrors.badGateway(String(err?.message || err));
    } finally {
      db.close();
    }
  });
}

```

# apps\ingester\package.json

```json
{
  "name": "@feedly-clone/ingester",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "scripts": {
    "dev": "node src/ingester.mjs"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "node-cron": "^3.0.3",
    "rss-parser": "^3.13.0",
    "undici": "^6.19.8",
    "cheerio": "^1.0.0-rc.12"
  }
}

```

# apps\ingester\src\db.mjs

```mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");

function defaultDbPath() {
  return path.resolve(repoRoot, "data", "dev.sqlite");
}

const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : defaultDbPath();

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  return db;
}

```

# apps\ingester\src\ingester.mjs

```mjs
import cron from "node-cron";
import Parser from "rss-parser";
import { fetch } from "undici";
import * as cheerio from "cheerio";
import { openDb } from "./db.mjs";
import { makeItemId, pickImage, stableHash, toIsoOrNull } from "./util.mjs";
import kyCounties from "./ky-counties.json" with { type: "json" };
import kyCityCounty from "./ky-city-county.json" with { type: "json" };

const parser = new Parser({
  customFields: {
    item: [
      ["media:content", "media:content"],
      ["media:thumbnail", "media:thumbnail"],
      ["itunes:image", "itunes:image"]
    ]
  }
});

const INTERVAL_MINUTES = Number(process.env.INGEST_INTERVAL_MINUTES || 15);
const FEED_TIMEOUT_MS = Number(process.env.FEED_TIMEOUT_MS || 15000);
const ARTICLE_TIMEOUT_MS = Number(process.env.ARTICLE_TIMEOUT_MS || 12000);
const ARTICLE_MAX_CHARS = Number(process.env.ARTICLE_MAX_CHARS || 2_000_000); // HTML chars
const EXCERPT_MAX_CHARS = Number(process.env.ARTICLE_EXCERPT_MAX_CHARS || 10_000);

// Simple text normalization for matching
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const KY_COUNTY_PATTERNS = (() => {
  const names = (kyCounties || []).map((c) => c.name).filter(Boolean);
  names.sort((a, b) => b.length - a.length);
  return names.map((name) => {
    const n = norm(name);
    // Match "X county", "X co", "X co.", etc.
    const re = new RegExp(`\\b${n.replace(/\s+/g, "\\s+")}\\s+(county|co\\.?)(\\b|\\s|,|\\.)`, "i");
    return { name, re };
  });
})();


const KY_CITY_PATTERNS = (() => {
  const rows = Array.isArray(kyCityCounty) ? kyCityCounty : [];
  // Longer first to avoid partial matches ("Fort Thomas" before "Thomas")
  const cities = rows
    .map((r) => ({ city: String(r.city || "").trim(), county: String(r.county || "").trim() }))
    .filter((r) => r.city && r.county);
  cities.sort((a, b) => b.city.length - a.city.length);

  return cities.map(({ city, county }) => {
    const n = norm(city);
    // Match city name as a whole phrase (word boundaries), allowing whitespace between words.
    const re = new RegExp(`\\b${n.replace(/\\s+/g, "\\s+")}\\b`, "i");
    return { city, county, re };
  });
})();

const OTHER_STATE_NAME_PATTERNS = (() => {
  const names = [
    "Alabama",
    "Alaska",
    "Arizona",
    "Arkansas",
    "California",
    "Colorado",
    "Connecticut",
    "Delaware",
    "Florida",
    "Georgia",
    "Hawaii",
    "Idaho",
    "Illinois",
    "Indiana",
    "Iowa",
    "Kansas",
    "Louisiana",
    "Maine",
    "Maryland",
    "Massachusetts",
    "Michigan",
    "Minnesota",
    "Mississippi",
    "Missouri",
    "Montana",
    "Nebraska",
    "Nevada",
    "New Hampshire",
    "New Jersey",
    "New Mexico",
    "New York",
    "North Carolina",
    "North Dakota",
    "Ohio",
    "Oklahoma",
    "Oregon",
    "Pennsylvania",
    "Rhode Island",
    "South Carolina",
    "South Dakota",
    "Tennessee",
    "Texas",
    "Utah",
    "Vermont",
    "Virginia",
    "Washington",
    "West Virginia",
    "Wisconsin",
    "Wyoming",
    "District of Columbia"
  ];
  return names.map((name) => ({
    name,
    re: new RegExp(`\\b${norm(name).replace(/\s+/g, "\\s+")}\\b`, "i")
  }));
})();

function hasKySignal(text, counties) {
  if (counties.length) return true;
  const raw = String(text || "");
  return /\bkentucky\b/i.test(raw) || /\bky\b/i.test(raw);
}

function detectOtherStateNames(text) {
  const t = norm(text);
  if (!t) return [];
  const out = [];
  for (const { name, re } of OTHER_STATE_NAME_PATTERNS) {
    if (re.test(t)) out.push(name);
  }
  return Array.from(new Set(out));
}



function detectKyCounties(text) {
  const t = norm(text);
  if (!t) return [];
  const out = [];
  const raw = String(text || "");
  const hasKyContext = /\bkentucky\b/i.test(raw) || /\bky\b/i.test(raw);

  // Direct county mentions: "X County" / "X Co."
  for (const { name, re } of KY_COUNTY_PATTERNS) {
    if (re.test(t)) out.push(name);
  }

  // City names are highly ambiguous across states; require explicit Kentucky context.
  if (hasKyContext) {
    for (const { county, re } of KY_CITY_PATTERNS) {
      if (re.test(t)) out.push(county);
    }
  }

  return Array.from(new Set(out));
}

function extractReadableText(html) {
  const $ = cheerio.load(html, { decodeEntities: true });

  // Remove obvious non-content
  $("script,style,noscript,iframe,svg,canvas,form,header,footer,nav,aside,button").remove();

  // Prefer semantic containers when present
  let text = $("article").text() || $("main").text() || $("#main").text() || $("body").text() || "";
  text = text
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();

  if (text.length > EXCERPT_MAX_CHARS) text = text.slice(0, EXCERPT_MAX_CHARS);
  return text;
}

function pickOgImage(html) {
  try {
    const $ = cheerio.load(html, { decodeEntities: true });
    const og =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="og:image"]').attr("content") ||
      $('meta[property="twitter:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      null;
    if (og && /^https?:\/\//i.test(og)) return og;
  } catch {
    // ignore
  }
  return null;
}

function pickInlineImage(html, pageUrl) {
  try {
    const $ = cheerio.load(html, { decodeEntities: true });
    const imgs = $("article img, main img, .entry-content img, .post-content img, img").toArray();
    for (const el of imgs) {
      const src =
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        $(el).attr("data-lazy-src") ||
        $(el).attr("data-original");
      if (!src) continue;
      const lower = String(src).toLowerCase();
      if (lower.startsWith("data:")) continue;
      if (/\b(sprite|logo|icon|avatar)\b/i.test(lower)) continue;

      let abs = "";
      try {
        abs = new URL(src, pageUrl).toString();
      } catch {
        abs = "";
      }
      if (!/^https?:\/\//i.test(abs)) continue;
      return abs;
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchArticle(url) {
  if (!url || !/^https?:\/\//i.test(url)) return { status: "skip", text: "", ogImage: null };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ARTICLE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // Gentle headers; many sites respond better with a UA.
        "user-agent": "Mozilla/5.0 (compatible; FeedlyCloneLocal/1.0; +https://localhost)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (res.status < 200 || res.status >= 300) return { status: `http_${res.status}`, text: "", ogImage: null };

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
      return { status: "non_html", text: "", ogImage: null };
    }

    let html = await res.text();
    if (html.length > ARTICLE_MAX_CHARS) html = html.slice(0, ARTICLE_MAX_CHARS);

    const ogImage = pickOgImage(html) || pickInlineImage(html, url);
    const text = extractReadableText(html);
    return { status: "ok", text, ogImage };
  } catch (e) {
    return { status: "error", text: "", ogImage: null };
  } finally {
    clearTimeout(t);
  }
}

function ensureSchema(db) {
  // Add optional columns for article fetching (safe to run repeatedly)
  const itemCols = db.prepare("PRAGMA table_info(items)").all().map((r) => r.name);
  const feedCols = db.prepare("PRAGMA table_info(feeds)").all().map((r) => r.name);
  const add = (name, type) => {
    if (!itemCols.includes(name)) {
      db.prepare(`ALTER TABLE items ADD COLUMN ${name} ${type}`).run();
    }
  };
  const addFeed = (name, type) => {
    if (!feedCols.includes(name)) {
      db.prepare(`ALTER TABLE feeds ADD COLUMN ${name} ${type}`).run();
    }
  };
  addFeed("region_scope", "TEXT NOT NULL DEFAULT 'ky'");
  addFeed("default_county", "TEXT");
  add("region_scope", "TEXT NOT NULL DEFAULT 'ky'");
  add("article_checked_at", "TEXT");
  add("article_fetch_status", "TEXT");
  add("article_text_excerpt", "TEXT");
}

function recordError(db, feedId, err) {
  db.prepare("INSERT INTO fetch_errors (feed_id, at, error) VALUES (?, datetime('now'), ?)").run(
    feedId,
    String(err?.stack || err)
  );
}

function startRun(db) {
  const stmt = db.prepare("INSERT INTO fetch_runs (started_at, status) VALUES (datetime('now'), 'running')");
  const info = stmt.run();
  return info.lastInsertRowid;
}

function finishRun(db, runId, status) {
  db.prepare("UPDATE fetch_runs SET finished_at=datetime('now'), status=? WHERE id=?").run(status, runId);
}

async function fetchWithConditional(url, etag, lastModified) {
  const headers = {};
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);

  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });

    if (res.status === 304) return { status: 304, etag, lastModified, text: null };
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} for ${url} :: ${body.slice(0, 200)}`);
    }

    const newEtag = res.headers.get("etag") || etag || null;
    const newLast = res.headers.get("last-modified") || lastModified || null;
    const text = await res.text();
    return { status: res.status, etag: newEtag, lastModified: newLast, text };
  } finally {
    clearTimeout(t);
  }
}

function upsertItemAndLink(db, feedId, row) {
  const insertItem = db.prepare(`
    INSERT INTO items (id, title, url, guid, author, region_scope, published_at, summary, content, image_url, hash)
    VALUES (@id, @title, @url, @guid, @author, @region_scope, @published_at, @summary, @content, @image_url, @hash)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      author=excluded.author,
      region_scope=excluded.region_scope,
      published_at=excluded.published_at,
      summary=excluded.summary,
      content=excluded.content,
      image_url=excluded.image_url,
      hash=excluded.hash
  `);

  const linkFeedItem = db.prepare(`INSERT OR IGNORE INTO feed_items (feed_id, item_id) VALUES (?, ?)`);

  insertItem.run(row);
  linkFeedItem.run(feedId, row.id);
}

async function tagItemLocations(db, itemId, stateCode, parts, url, defaultCounty = "", feedUrl = "") {
  const st = (stateCode || "KY").toUpperCase();

  const del = db.prepare("DELETE FROM item_locations WHERE item_id=? AND state_code=?");
  const ins = db.prepare(
    "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, ?, ?)"
  );

  del.run(itemId, st);

  const baseText = parts.filter(Boolean).join(" \n ");
  let signalText = baseText;
  let counties = detectKyCounties(baseText);
  let otherStateNames = st === "KY" ? detectOtherStateNames(baseText) : [];

  const meta = db
    .prepare("SELECT article_checked_at, article_fetch_status, image_url FROM items WHERE id=?")
    .get(itemId);

  const alreadyChecked = Boolean(meta?.article_checked_at);
  const needsImage = !String(meta?.image_url || "").trim();

  if ((!counties.length || needsImage) && !alreadyChecked) {
    const fetched = await fetchArticle(url);
    const excerpt = fetched.text || "";
    signalText = `${signalText}\n${excerpt}`;
    counties = detectKyCounties(excerpt);
    if (st === "KY") {
      otherStateNames = Array.from(new Set([...otherStateNames, ...detectOtherStateNames(excerpt)]));
    }

    const update = db.prepare(`
      UPDATE items
      SET
        article_checked_at = datetime('now'),
        article_fetch_status = @status,
        article_text_excerpt = @excerpt,
        content = COALESCE(content, @excerpt),
        image_url = COALESCE(image_url, @ogImage)
      WHERE id=@id
    `);
    update.run({
      id: itemId,
      status: fetched.status,
      excerpt: excerpt || null,
      ogImage: fetched.ogImage || null
    });
  }

  // Guard against false local tags on clearly out-of-state stories
  // (e.g. "West Virginia Cash Pop" from a KY source feed).
  const isKyGoogleWatchFeed =
    /news\.google\.com\/rss\/search/i.test(String(feedUrl || "")) &&
    /kentucky/i.test(decodeURIComponent(String(feedUrl || "")));
  const kySignal = st !== "KY" ? true : isKyGoogleWatchFeed || hasKySignal(signalText, counties);
  const hasOtherStateSignal = st === "KY" && otherStateNames.length > 0;
  const shouldTagAsKy = st !== "KY" || !hasOtherStateSignal || kySignal;
  if (!shouldTagAsKy) return;

  // Keep a state-level marker for valid in-state content.
  ins.run(itemId, st, "");

  if (st === "KY") {
    const out = new Set(counties);
    const c = String(defaultCounty || "").trim();
    if (c && kySignal && (!hasOtherStateSignal || counties.length > 0)) out.add(c);
    for (const county of out) ins.run(itemId, st, county);
  }
}

async function ingestOnce() {
  const db = openDb();
  ensureSchema(db);
  const runId = startRun(db);

  try {
    const feeds = db
      .prepare(
        "SELECT id, url, etag, last_modified, state_code, region_scope, default_county FROM feeds WHERE enabled=1 ORDER BY name"
      )
      .all();

    const updateFeedMeta = db.prepare(`
      UPDATE feeds
      SET etag=@etag, last_modified=@last_modified, last_checked_at=datetime('now')
      WHERE id=@id
    `);

    const tx = db.transaction((fn) => fn());

    for (const f of feeds) {
      try {
        const { status, etag, lastModified, text } = await fetchWithConditional(f.url, f.etag, f.last_modified);
        updateFeedMeta.run({ id: f.id, etag, last_modified: lastModified });

        if (status === 304 || !text) continue;

        const feed = await parser.parseString(text);
        const items = feed.items || [];

        for (const it of items) {
          const published_at = toIsoOrNull(it.isoDate || it.pubDate);
          const url = it.link || it.guid || "";
          const title = (it.title || "").trim() || "(untitled)";
          const summary = (it.contentSnippet || "").trim() || null;
          const content = (it.content || "").trim() || null;
          const author = (it.creator || it.author || "").trim() || null;
          const image_url = pickImage(it);

          const id = makeItemId({ url, guid: it.guid, title, published_at });
          const hash = stableHash([title, url, summary || "", content || "", author || "", published_at || ""].join("|"));

          // Upsert item + link in a quick transaction
          tx(() => {
            upsertItemAndLink(db, f.id, {
              id,
              title,
              url,
              guid: it.guid || null,
              author,
              region_scope: f.region_scope === "national" ? "national" : "ky",
              published_at,
              summary,
              content,
              image_url,
              hash
            });
          });

          // Only Kentucky feeds participate in state/county tagging.
          if ((f.region_scope || "ky") === "ky") {
            await tagItemLocations(
              db,
              id,
              f.state_code || "KY",
              [title, summary, content],
              url,
              f.default_county || "",
              f.url || ""
            );
          }
        }
      } catch (err) {
        recordError(db, f.id, err);
        // keep going
      }
    }

    finishRun(db, runId, "ok");
  } catch (err) {
    finishRun(db, runId, "failed");
    throw err;
  } finally {
    db.close();
  }
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[ingester] ${ts} ${msg}`);
}

async function main() {
  const runOnce = process.argv.includes("--once") || process.env.INGEST_ONCE === "1";
  log(`Starting ingester. Interval: ${INTERVAL_MINUTES} minutes`);

  // Run once at startup
  await ingestOnce().catch((e) => log(`Initial ingest failed: ${String(e?.message || e)}`));

  if (runOnce) {
    log("Ingest once complete, exiting.");
    return;
  }

  // Then on schedule
  cron.schedule(`*/${INTERVAL_MINUTES} * * * *`, async () => {
    log("Ingest tick");
    await ingestOnce().catch((e) => log(`Ingest failed: ${String(e?.message || e)}`));
  });
}

main();

```

# apps\ingester\src\ky-city-county.json

```json
[
  {
    "city": "Louisville",
    "county": "Jefferson"
  },
  {
    "city": "Lexington",
    "county": "Fayette"
  },
  {
    "city": "Bowling Green",
    "county": "Warren"
  },
  {
    "city": "Owensboro",
    "county": "Daviess"
  },
  {
    "city": "Covington",
    "county": "Kenton"
  },
  {
    "city": "Frankfort",
    "county": "Franklin"
  },
  {
    "city": "Paducah",
    "county": "McCracken"
  },
  {
    "city": "Richmond",
    "county": "Madison"
  },
  {
    "city": "Georgetown",
    "county": "Scott"
  },
  {
    "city": "Florence",
    "county": "Boone"
  },
  {
    "city": "Hopkinsville",
    "county": "Christian"
  },
  {
    "city": "Elizabethtown",
    "county": "Hardin"
  },
  {
    "city": "Nicholasville",
    "county": "Jessamine"
  },
  {
    "city": "Henderson",
    "county": "Henderson"
  },
  {
    "city": "Ashland",
    "county": "Boyd"
  },
  {
    "city": "Somerset",
    "county": "Pulaski"
  },
  {
    "city": "Danville",
    "county": "Boyle"
  },
  {
    "city": "Murray",
    "county": "Calloway"
  },
  {
    "city": "Mayfield",
    "county": "Graves"
  },
  {
    "city": "Bardstown",
    "county": "Nelson"
  },
  {
    "city": "Shelbyville",
    "county": "Shelby"
  },
  {
    "city": "London",
    "county": "Laurel"
  },
  {
    "city": "Pikeville",
    "county": "Pike"
  },
  {
    "city": "Hazard",
    "county": "Perry"
  },
  {
    "city": "Morehead",
    "county": "Rowan"
  },
  {
    "city": "Mount Sterling",
    "county": "Montgomery"
  },
  {
    "city": "Maysville",
    "county": "Mason"
  },
  {
    "city": "Prestonsburg",
    "county": "Floyd"
  },
  {
    "city": "Paintsville",
    "county": "Johnson"
  },
  {
    "city": "Russellville",
    "county": "Logan"
  },
  {
    "city": "Glasgow",
    "county": "Barren"
  },
  {
    "city": "Campbellsville",
    "county": "Taylor"
  },
  {
    "city": "Berea",
    "county": "Madison"
  },
  {
    "city": "Harrodsburg",
    "county": "Mercer"
  },
  {
    "city": "Versailles",
    "county": "Woodford"
  },
  {
    "city": "La Grange",
    "county": "Oldham"
  },
  {
    "city": "Carrollton",
    "county": "Carroll"
  },
  {
    "city": "Princeton",
    "county": "Caldwell"
  },
  {
    "city": "Benton",
    "county": "Marshall"
  },
  {
    "city": "Cadiz",
    "county": "Trigg"
  },
  {
    "city": "Columbia",
    "county": "Adair"
  },
  {
    "city": "Jamestown",
    "county": "Russell"
  },
  {
    "city": "Monticello",
    "county": "Wayne"
  },
  {
    "city": "Corbin",
    "county": "Whitley"
  },
  {
    "city": "Harlan",
    "county": "Harlan"
  },
  {
    "city": "Whitesburg",
    "county": "Letcher"
  },
  {
    "city": "Inez",
    "county": "Martin"
  },
  {
    "city": "Jackson",
    "county": "Breathitt"
  },
  {
    "city": "Manchester",
    "county": "Clay"
  },
  {
    "city": "Pineville",
    "county": "Bell"
  },
  {
    "city": "Barbourville",
    "county": "Knox"
  },
  {
    "city": "Middlesboro",
    "county": "Bell"
  },
  {
    "city": "Williamsburg",
    "county": "Whitley"
  },
  {
    "city": "Somerset",
    "county": "Pulaski"
  },
  {
    "city": "Newport",
    "county": "Campbell"
  },
  {
    "city": "Fort Thomas",
    "county": "Campbell"
  },
  {
    "city": "Erlanger",
    "county": "Kenton"
  },
  {
    "city": "Independence",
    "county": "Kenton"
  },
  {
    "city": "Fort Wright",
    "county": "Kenton"
  },
  {
    "city": "Alexandria",
    "county": "Campbell"
  },
  {
    "city": "Union",
    "county": "Boone"
  },
  {
    "city": "Burlington",
    "county": "Boone"
  },
  {
    "city": "Hebron",
    "county": "Boone"
  },
  {
    "city": "Jeffersontown",
    "county": "Jefferson"
  },
  {
    "city": "St. Matthews",
    "county": "Jefferson"
  },
  {
    "city": "Shively",
    "county": "Jefferson"
  },
  {
    "city": "Okolona",
    "county": "Jefferson"
  }
]
```

# apps\ingester\src\ky-counties.json

```json
[
  {
    "name": "Adair",
    "full": "Adair County",
    "fips": "21001"
  },
  {
    "name": "Allen",
    "full": "Allen County",
    "fips": "21003"
  },
  {
    "name": "Anderson",
    "full": "Anderson County",
    "fips": "21005"
  },
  {
    "name": "Ballard",
    "full": "Ballard County",
    "fips": "21007"
  },
  {
    "name": "Barren",
    "full": "Barren County",
    "fips": "21009"
  },
  {
    "name": "Bath",
    "full": "Bath County",
    "fips": "21011"
  },
  {
    "name": "Bell",
    "full": "Bell County",
    "fips": "21013"
  },
  {
    "name": "Boone",
    "full": "Boone County",
    "fips": "21015"
  },
  {
    "name": "Bourbon",
    "full": "Bourbon County",
    "fips": "21017"
  },
  {
    "name": "Boyd",
    "full": "Boyd County",
    "fips": "21019"
  },
  {
    "name": "Boyle",
    "full": "Boyle County",
    "fips": "21021"
  },
  {
    "name": "Bracken",
    "full": "Bracken County",
    "fips": "21023"
  },
  {
    "name": "Breathitt",
    "full": "Breathitt County",
    "fips": "21025"
  },
  {
    "name": "Breckinridge",
    "full": "Breckinridge County",
    "fips": "21027"
  },
  {
    "name": "Bullitt",
    "full": "Bullitt County",
    "fips": "21029"
  },
  {
    "name": "Butler",
    "full": "Butler County",
    "fips": "21031"
  },
  {
    "name": "Caldwell",
    "full": "Caldwell County",
    "fips": "21033"
  },
  {
    "name": "Calloway",
    "full": "Calloway County",
    "fips": "21035"
  },
  {
    "name": "Campbell",
    "full": "Campbell County",
    "fips": "21037"
  },
  {
    "name": "Carlisle",
    "full": "Carlisle County",
    "fips": "21039"
  },
  {
    "name": "Carroll",
    "full": "Carroll County",
    "fips": "21041"
  },
  {
    "name": "Carter",
    "full": "Carter County",
    "fips": "21043"
  },
  {
    "name": "Casey",
    "full": "Casey County",
    "fips": "21045"
  },
  {
    "name": "Christian",
    "full": "Christian County",
    "fips": "21047"
  },
  {
    "name": "Clark",
    "full": "Clark County",
    "fips": "21049"
  },
  {
    "name": "Clay",
    "full": "Clay County",
    "fips": "21051"
  },
  {
    "name": "Clinton",
    "full": "Clinton County",
    "fips": "21053"
  },
  {
    "name": "Crittenden",
    "full": "Crittenden County",
    "fips": "21055"
  },
  {
    "name": "Cumberland",
    "full": "Cumberland County",
    "fips": "21057"
  },
  {
    "name": "Daviess",
    "full": "Daviess County",
    "fips": "21059"
  },
  {
    "name": "Edmonson",
    "full": "Edmonson County",
    "fips": "21061"
  },
  {
    "name": "Elliott",
    "full": "Elliott County",
    "fips": "21063"
  },
  {
    "name": "Estill",
    "full": "Estill County",
    "fips": "21065"
  },
  {
    "name": "Fayette",
    "full": "Fayette County",
    "fips": "21067"
  },
  {
    "name": "Fleming",
    "full": "Fleming County",
    "fips": "21069"
  },
  {
    "name": "Floyd",
    "full": "Floyd County",
    "fips": "21071"
  },
  {
    "name": "Franklin",
    "full": "Franklin County",
    "fips": "21073"
  },
  {
    "name": "Fulton",
    "full": "Fulton County",
    "fips": "21075"
  },
  {
    "name": "Gallatin",
    "full": "Gallatin County",
    "fips": "21077"
  },
  {
    "name": "Garrard",
    "full": "Garrard County",
    "fips": "21079"
  },
  {
    "name": "Grant",
    "full": "Grant County",
    "fips": "21081"
  },
  {
    "name": "Graves",
    "full": "Graves County",
    "fips": "21083"
  },
  {
    "name": "Grayson",
    "full": "Grayson County",
    "fips": "21085"
  },
  {
    "name": "Green",
    "full": "Green County",
    "fips": "21087"
  },
  {
    "name": "Greenup",
    "full": "Greenup County",
    "fips": "21089"
  },
  {
    "name": "Hancock",
    "full": "Hancock County",
    "fips": "21091"
  },
  {
    "name": "Hardin",
    "full": "Hardin County",
    "fips": "21093"
  },
  {
    "name": "Harlan",
    "full": "Harlan County",
    "fips": "21095"
  },
  {
    "name": "Harrison",
    "full": "Harrison County",
    "fips": "21097"
  },
  {
    "name": "Hart",
    "full": "Hart County",
    "fips": "21099"
  },
  {
    "name": "Henderson",
    "full": "Henderson County",
    "fips": "21101"
  },
  {
    "name": "Henry",
    "full": "Henry County",
    "fips": "21103"
  },
  {
    "name": "Hickman",
    "full": "Hickman County",
    "fips": "21105"
  },
  {
    "name": "Hopkins",
    "full": "Hopkins County",
    "fips": "21107"
  },
  {
    "name": "Jackson",
    "full": "Jackson County",
    "fips": "21109"
  },
  {
    "name": "Jefferson",
    "full": "Jefferson County",
    "fips": "21111"
  },
  {
    "name": "Jessamine",
    "full": "Jessamine County",
    "fips": "21113"
  },
  {
    "name": "Johnson",
    "full": "Johnson County",
    "fips": "21115"
  },
  {
    "name": "Kenton",
    "full": "Kenton County",
    "fips": "21117"
  },
  {
    "name": "Knott",
    "full": "Knott County",
    "fips": "21119"
  },
  {
    "name": "Knox",
    "full": "Knox County",
    "fips": "21121"
  },
  {
    "name": "Larue",
    "full": "Larue County",
    "fips": "21123"
  },
  {
    "name": "Laurel",
    "full": "Laurel County",
    "fips": "21125"
  },
  {
    "name": "Lawrence",
    "full": "Lawrence County",
    "fips": "21127"
  },
  {
    "name": "Lee",
    "full": "Lee County",
    "fips": "21129"
  },
  {
    "name": "Leslie",
    "full": "Leslie County",
    "fips": "21131"
  },
  {
    "name": "Letcher",
    "full": "Letcher County",
    "fips": "21133"
  },
  {
    "name": "Lewis",
    "full": "Lewis County",
    "fips": "21135"
  },
  {
    "name": "Lincoln",
    "full": "Lincoln County",
    "fips": "21137"
  },
  {
    "name": "Livingston",
    "full": "Livingston County",
    "fips": "21139"
  },
  {
    "name": "Logan",
    "full": "Logan County",
    "fips": "21141"
  },
  {
    "name": "Lyon",
    "full": "Lyon County",
    "fips": "21143"
  },
  {
    "name": "Madison",
    "full": "Madison County",
    "fips": "21151"
  },
  {
    "name": "Magoffin",
    "full": "Magoffin County",
    "fips": "21153"
  },
  {
    "name": "Marion",
    "full": "Marion County",
    "fips": "21155"
  },
  {
    "name": "Marshall",
    "full": "Marshall County",
    "fips": "21157"
  },
  {
    "name": "Martin",
    "full": "Martin County",
    "fips": "21159"
  },
  {
    "name": "Mason",
    "full": "Mason County",
    "fips": "21161"
  },
  {
    "name": "McCracken",
    "full": "McCracken County",
    "fips": "21145"
  },
  {
    "name": "McCreary",
    "full": "McCreary County",
    "fips": "21147"
  },
  {
    "name": "McLean",
    "full": "McLean County",
    "fips": "21149"
  },
  {
    "name": "Meade",
    "full": "Meade County",
    "fips": "21163"
  },
  {
    "name": "Menifee",
    "full": "Menifee County",
    "fips": "21165"
  },
  {
    "name": "Mercer",
    "full": "Mercer County",
    "fips": "21167"
  },
  {
    "name": "Metcalfe",
    "full": "Metcalfe County",
    "fips": "21169"
  },
  {
    "name": "Monroe",
    "full": "Monroe County",
    "fips": "21171"
  },
  {
    "name": "Montgomery",
    "full": "Montgomery County",
    "fips": "21173"
  },
  {
    "name": "Morgan",
    "full": "Morgan County",
    "fips": "21175"
  },
  {
    "name": "Muhlenberg",
    "full": "Muhlenberg County",
    "fips": "21177"
  },
  {
    "name": "Nelson",
    "full": "Nelson County",
    "fips": "21179"
  },
  {
    "name": "Nicholas",
    "full": "Nicholas County",
    "fips": "21181"
  },
  {
    "name": "Ohio",
    "full": "Ohio County",
    "fips": "21183"
  },
  {
    "name": "Oldham",
    "full": "Oldham County",
    "fips": "21185"
  },
  {
    "name": "Owen",
    "full": "Owen County",
    "fips": "21187"
  },
  {
    "name": "Owsley",
    "full": "Owsley County",
    "fips": "21189"
  },
  {
    "name": "Pendleton",
    "full": "Pendleton County",
    "fips": "21191"
  },
  {
    "name": "Perry",
    "full": "Perry County",
    "fips": "21193"
  },
  {
    "name": "Pike",
    "full": "Pike County",
    "fips": "21195"
  },
  {
    "name": "Powell",
    "full": "Powell County",
    "fips": "21197"
  },
  {
    "name": "Pulaski",
    "full": "Pulaski County",
    "fips": "21199"
  },
  {
    "name": "Robertson",
    "full": "Robertson County",
    "fips": "21201"
  },
  {
    "name": "Rockcastle",
    "full": "Rockcastle County",
    "fips": "21203"
  },
  {
    "name": "Rowan",
    "full": "Rowan County",
    "fips": "21205"
  },
  {
    "name": "Russell",
    "full": "Russell County",
    "fips": "21207"
  },
  {
    "name": "Scott",
    "full": "Scott County",
    "fips": "21209"
  },
  {
    "name": "Shelby",
    "full": "Shelby County",
    "fips": "21211"
  },
  {
    "name": "Simpson",
    "full": "Simpson County",
    "fips": "21213"
  },
  {
    "name": "Spencer",
    "full": "Spencer County",
    "fips": "21215"
  },
  {
    "name": "Taylor",
    "full": "Taylor County",
    "fips": "21217"
  },
  {
    "name": "Todd",
    "full": "Todd County",
    "fips": "21219"
  },
  {
    "name": "Trigg",
    "full": "Trigg County",
    "fips": "21221"
  },
  {
    "name": "Trimble",
    "full": "Trimble County",
    "fips": "21223"
  },
  {
    "name": "Union",
    "full": "Union County",
    "fips": "21225"
  },
  {
    "name": "Warren",
    "full": "Warren County",
    "fips": "21227"
  },
  {
    "name": "Washington",
    "full": "Washington County",
    "fips": "21229"
  },
  {
    "name": "Wayne",
    "full": "Wayne County",
    "fips": "21231"
  },
  {
    "name": "Webster",
    "full": "Webster County",
    "fips": "21233"
  },
  {
    "name": "Whitley",
    "full": "Whitley County",
    "fips": "21235"
  },
  {
    "name": "Wolfe",
    "full": "Wolfe County",
    "fips": "21237"
  },
  {
    "name": "Woodford",
    "full": "Woodford County",
    "fips": "21239"
  }
]
```

# apps\ingester\src\util.mjs

```mjs
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

```

# apps\web\index.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#ffffff" />
    <title>Kentucky News</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>

```

# apps\web\package.json

```json
{
  "name": "@feedly-clone/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "dexie": "^4.0.10",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
  "devDependencies": {
    "@types/react": "^18.3.4",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vite-plugin-pwa": "^0.20.5"
  }
}

```

# apps\web\public\favicon.svg

This is a file of the type: SVG Image

# apps\web\public\pwa-192.png

This is a binary file of the type: Image

# apps\web\public\pwa-512.png

This is a binary file of the type: Image

# apps\web\src\data\api.ts

```ts
export type NewsScope = "ky" | "national" | "all";

export type Feed = {
  id: string;
  name: string;
  category: string;
  url: string;
  state_code?: string;
  region_scope?: NewsScope;
  enabled: number;
};

export type Item = {
  id: string;
  title: string;
  url: string;
  author?: string | null;
  region_scope?: "ky" | "national";
  published_at?: string | null;
  summary?: string | null;
  content?: string | null;
  image_url?: string | null;
  states?: string[];
  counties?: string[];
};

export type CountyCount = { county: string; count: number };

export type WeatherForecastPeriod = {
  name: string;
  startTime: string;
  endTime: string;
  temperature: number;
  temperatureUnit: string;
  shortForecast: string;
  detailedForecast: string;
  windSpeed?: string;
  windDirection?: string;
  icon?: string;
};

export type WeatherForecast = {
  state: string;
  county: string;
  zoneId: string;
  updatedAt: string;
  periods: WeatherForecastPeriod[];
  source: string;
  fetchedAt?: string;
  expiresAt?: string;
  cached?: boolean;
  stale?: boolean;
  warning?: string;
};

export type WeatherAlert = {
  id: string;
  event: string;
  severity: string;
  headline: string;
  description: string;
  instruction: string;
  starts_at?: string | null;
  ends_at?: string | null;
  sent_at?: string | null;
  status?: string | null;
  url?: string | null;
  area_desc?: string;
};

export type LostFoundType = "lost" | "found";

export type LostFoundPost = {
  id: string;
  type: LostFoundType;
  title: string;
  description: string;
  county: string;
  state_code: string;
  status: "pending" | "approved" | "rejected";
  show_contact: boolean;
  contact_email?: string | null;
  submitted_at: string;
  approved_at?: string | null;
  rejected_at?: string | null;
  expires_at: string;
  moderation_note?: string | null;
  images: string[];
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text);
        const msg = parsed?.message || parsed?.error || text;
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      } catch {
        throw new Error(text || `Request failed: ${res.status}`);
      }
    }
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getFeeds(opts: { scope?: NewsScope } = {}): Promise<Feed[]> {
  const params = new URLSearchParams();
  if (opts.scope) params.set("scope", opts.scope);
  const qs = params.toString();
  const data = await fetchJson<{ feeds: Feed[] }>(`/api/feeds${qs ? `?${qs}` : ""}`);
  return data.feeds;
}

export async function getItems(
  opts: {
    feedId?: string;
    category?: string;
    scope?: NewsScope;
    state?: string;
    county?: string;
    counties?: string[];
    hours?: number;
    cursor?: string | null;
    limit?: number;
  } = {}
) {
  const params = new URLSearchParams();
  if (opts.feedId) params.set("feedId", opts.feedId);
  if (opts.category) params.set("category", opts.category);
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.state) params.set("state", opts.state);
  if (opts.county) params.set("county", opts.county);
  if (opts.counties?.length) {
    for (const county of opts.counties) params.append("counties", county);
  }
  if (opts.hours != null) params.set("hours", String(opts.hours));
  if (opts.cursor) params.set("cursor", opts.cursor);
  params.set("limit", String(opts.limit ?? 30));
  return fetchJson<{ items: (Item & { sort_ts?: string })[]; nextCursor: string | null }>(`/api/items?${params.toString()}`);
}

export async function searchItems(
  q: string,
  opts: {
    scope?: NewsScope;
    state?: string;
    county?: string;
    counties?: string[];
    hours?: number;
    cursor?: string | null;
    limit?: number;
  } = {}
) {
  const params = new URLSearchParams();
  params.set("q", q);
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.state) params.set("state", opts.state);
  if (opts.county) params.set("county", opts.county);
  if (opts.counties?.length) {
    for (const county of opts.counties) params.append("counties", county);
  }
  if (opts.hours != null) params.set("hours", String(opts.hours));
  if (opts.cursor) params.set("cursor", opts.cursor);
  params.set("limit", String(opts.limit ?? 30));
  return fetchJson<{ items: (Item & { sort_ts?: string })[]; nextCursor: string | null }>(`/api/search?${params.toString()}`);
}

export async function getItem(id: string): Promise<Item> {
  const data = await fetchJson<{ item: Item }>(`/api/items/${encodeURIComponent(id)}`);
  return data.item;
}

export async function getCounties(opts: { state?: string; hours?: number } = {}) {
  const params = new URLSearchParams();
  params.set("state", (opts.state ?? "KY").toUpperCase());
  if (opts.hours != null) params.set("hours", String(opts.hours));
  return fetchJson<{ state: string; hours: number; counties: CountyCount[] }>(`/api/counties?${params.toString()}`);
}

export async function getWeatherForecast(county: string, state = "KY") {
  const params = new URLSearchParams();
  params.set("state", state.toUpperCase());
  params.set("county", county);
  return fetchJson<WeatherForecast>(`/api/weather/forecast?${params.toString()}`);
}

export async function getWeatherAlerts(opts: { county?: string; state?: string } = {}) {
  const params = new URLSearchParams();
  params.set("state", (opts.state ?? "KY").toUpperCase());
  if (opts.county) params.set("county", opts.county);
  return fetchJson<{ state: string; county?: string | null; alerts: WeatherAlert[]; stale?: boolean; warning?: string }>(
    `/api/weather/alerts?${params.toString()}`
  );
}

export async function listLostFound(opts: { type?: LostFoundType; county?: string; status?: "published" | "pending" | "approved" | "rejected"; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.county) params.set("county", opts.county);
  if (opts.status) params.set("status", opts.status);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  return fetchJson<{ posts: LostFoundPost[]; status: string; county?: string | null }>(`/api/lost-found?${params.toString()}`);
}

export async function getLostFoundUploadUrl(filename: string, mimeType: string) {
  return fetchJson<{ objectKey: string; uploadUrl: string; method: "PUT"; headers: Record<string, string>; maxBytes: number }>(
    "/api/uploads/lost-found-url",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename, mimeType })
    }
  );
}

export async function uploadLostFoundImage(uploadUrl: string, file: File, headers: Record<string, string>) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: file
  });
  if (!res.ok) throw new Error("Image upload failed");
  return res.json() as Promise<{ ok: boolean; objectKey: string; bytes: number }>;
}

export async function submitLostFound(input: {
  type: LostFoundType;
  title: string;
  description: string;
  county: string;
  state?: string;
  contactEmail: string;
  showContact?: boolean;
  imageKeys?: string[];
}) {
  return fetchJson<{ ok: boolean; id: string; status: string }>("/api/lost-found/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      state: (input.state ?? "KY").toUpperCase(),
      showContact: input.showContact ?? false,
      imageKeys: input.imageKeys ?? []
    })
  });
}

export async function getOpenProxy(url: string) {
  const params = new URLSearchParams();
  params.set("url", url);
  return fetchJson<{ url: string; finalUrl: string; title: string; html: string }>(`/api/open-proxy?${params.toString()}`);
}

```

# apps\web\src\data\ky-city-county.json

```json
[
  {
    "city": "Louisville",
    "county": "Jefferson"
  },
  {
    "city": "Lexington",
    "county": "Fayette"
  },
  {
    "city": "Bowling Green",
    "county": "Warren"
  },
  {
    "city": "Owensboro",
    "county": "Daviess"
  },
  {
    "city": "Covington",
    "county": "Kenton"
  },
  {
    "city": "Frankfort",
    "county": "Franklin"
  },
  {
    "city": "Paducah",
    "county": "McCracken"
  },
  {
    "city": "Richmond",
    "county": "Madison"
  },
  {
    "city": "Georgetown",
    "county": "Scott"
  },
  {
    "city": "Florence",
    "county": "Boone"
  },
  {
    "city": "Hopkinsville",
    "county": "Christian"
  },
  {
    "city": "Elizabethtown",
    "county": "Hardin"
  },
  {
    "city": "Nicholasville",
    "county": "Jessamine"
  },
  {
    "city": "Henderson",
    "county": "Henderson"
  },
  {
    "city": "Ashland",
    "county": "Boyd"
  },
  {
    "city": "Somerset",
    "county": "Pulaski"
  },
  {
    "city": "Danville",
    "county": "Boyle"
  },
  {
    "city": "Murray",
    "county": "Calloway"
  },
  {
    "city": "Mayfield",
    "county": "Graves"
  },
  {
    "city": "Bardstown",
    "county": "Nelson"
  },
  {
    "city": "Shelbyville",
    "county": "Shelby"
  },
  {
    "city": "London",
    "county": "Laurel"
  },
  {
    "city": "Pikeville",
    "county": "Pike"
  },
  {
    "city": "Hazard",
    "county": "Perry"
  },
  {
    "city": "Morehead",
    "county": "Rowan"
  },
  {
    "city": "Mount Sterling",
    "county": "Montgomery"
  },
  {
    "city": "Maysville",
    "county": "Mason"
  },
  {
    "city": "Prestonsburg",
    "county": "Floyd"
  },
  {
    "city": "Paintsville",
    "county": "Johnson"
  },
  {
    "city": "Russellville",
    "county": "Logan"
  },
  {
    "city": "Glasgow",
    "county": "Barren"
  },
  {
    "city": "Campbellsville",
    "county": "Taylor"
  },
  {
    "city": "Berea",
    "county": "Madison"
  },
  {
    "city": "Harrodsburg",
    "county": "Mercer"
  },
  {
    "city": "Versailles",
    "county": "Woodford"
  },
  {
    "city": "La Grange",
    "county": "Oldham"
  },
  {
    "city": "Carrollton",
    "county": "Carroll"
  },
  {
    "city": "Princeton",
    "county": "Caldwell"
  },
  {
    "city": "Benton",
    "county": "Marshall"
  },
  {
    "city": "Cadiz",
    "county": "Trigg"
  },
  {
    "city": "Columbia",
    "county": "Adair"
  },
  {
    "city": "Jamestown",
    "county": "Russell"
  },
  {
    "city": "Monticello",
    "county": "Wayne"
  },
  {
    "city": "Corbin",
    "county": "Whitley"
  },
  {
    "city": "Harlan",
    "county": "Harlan"
  },
  {
    "city": "Whitesburg",
    "county": "Letcher"
  },
  {
    "city": "Inez",
    "county": "Martin"
  },
  {
    "city": "Jackson",
    "county": "Breathitt"
  },
  {
    "city": "Manchester",
    "county": "Clay"
  },
  {
    "city": "Pineville",
    "county": "Bell"
  },
  {
    "city": "Barbourville",
    "county": "Knox"
  },
  {
    "city": "Middlesboro",
    "county": "Bell"
  },
  {
    "city": "Williamsburg",
    "county": "Whitley"
  },
  {
    "city": "Somerset",
    "county": "Pulaski"
  },
  {
    "city": "Newport",
    "county": "Campbell"
  },
  {
    "city": "Fort Thomas",
    "county": "Campbell"
  },
  {
    "city": "Erlanger",
    "county": "Kenton"
  },
  {
    "city": "Independence",
    "county": "Kenton"
  },
  {
    "city": "Fort Wright",
    "county": "Kenton"
  },
  {
    "city": "Alexandria",
    "county": "Campbell"
  },
  {
    "city": "Union",
    "county": "Boone"
  },
  {
    "city": "Burlington",
    "county": "Boone"
  },
  {
    "city": "Hebron",
    "county": "Boone"
  },
  {
    "city": "Jeffersontown",
    "county": "Jefferson"
  },
  {
    "city": "St. Matthews",
    "county": "Jefferson"
  },
  {
    "city": "Shively",
    "county": "Jefferson"
  },
  {
    "city": "Okolona",
    "county": "Jefferson"
  }
]
```

# apps\web\src\data\ky-counties.json

```json
[
  {
    "name": "Adair",
    "full": "Adair County",
    "fips": "21001"
  },
  {
    "name": "Allen",
    "full": "Allen County",
    "fips": "21003"
  },
  {
    "name": "Anderson",
    "full": "Anderson County",
    "fips": "21005"
  },
  {
    "name": "Ballard",
    "full": "Ballard County",
    "fips": "21007"
  },
  {
    "name": "Barren",
    "full": "Barren County",
    "fips": "21009"
  },
  {
    "name": "Bath",
    "full": "Bath County",
    "fips": "21011"
  },
  {
    "name": "Bell",
    "full": "Bell County",
    "fips": "21013"
  },
  {
    "name": "Boone",
    "full": "Boone County",
    "fips": "21015"
  },
  {
    "name": "Bourbon",
    "full": "Bourbon County",
    "fips": "21017"
  },
  {
    "name": "Boyd",
    "full": "Boyd County",
    "fips": "21019"
  },
  {
    "name": "Boyle",
    "full": "Boyle County",
    "fips": "21021"
  },
  {
    "name": "Bracken",
    "full": "Bracken County",
    "fips": "21023"
  },
  {
    "name": "Breathitt",
    "full": "Breathitt County",
    "fips": "21025"
  },
  {
    "name": "Breckinridge",
    "full": "Breckinridge County",
    "fips": "21027"
  },
  {
    "name": "Bullitt",
    "full": "Bullitt County",
    "fips": "21029"
  },
  {
    "name": "Butler",
    "full": "Butler County",
    "fips": "21031"
  },
  {
    "name": "Caldwell",
    "full": "Caldwell County",
    "fips": "21033"
  },
  {
    "name": "Calloway",
    "full": "Calloway County",
    "fips": "21035"
  },
  {
    "name": "Campbell",
    "full": "Campbell County",
    "fips": "21037"
  },
  {
    "name": "Carlisle",
    "full": "Carlisle County",
    "fips": "21039"
  },
  {
    "name": "Carroll",
    "full": "Carroll County",
    "fips": "21041"
  },
  {
    "name": "Carter",
    "full": "Carter County",
    "fips": "21043"
  },
  {
    "name": "Casey",
    "full": "Casey County",
    "fips": "21045"
  },
  {
    "name": "Christian",
    "full": "Christian County",
    "fips": "21047"
  },
  {
    "name": "Clark",
    "full": "Clark County",
    "fips": "21049"
  },
  {
    "name": "Clay",
    "full": "Clay County",
    "fips": "21051"
  },
  {
    "name": "Clinton",
    "full": "Clinton County",
    "fips": "21053"
  },
  {
    "name": "Crittenden",
    "full": "Crittenden County",
    "fips": "21055"
  },
  {
    "name": "Cumberland",
    "full": "Cumberland County",
    "fips": "21057"
  },
  {
    "name": "Daviess",
    "full": "Daviess County",
    "fips": "21059"
  },
  {
    "name": "Edmonson",
    "full": "Edmonson County",
    "fips": "21061"
  },
  {
    "name": "Elliott",
    "full": "Elliott County",
    "fips": "21063"
  },
  {
    "name": "Estill",
    "full": "Estill County",
    "fips": "21065"
  },
  {
    "name": "Fayette",
    "full": "Fayette County",
    "fips": "21067"
  },
  {
    "name": "Fleming",
    "full": "Fleming County",
    "fips": "21069"
  },
  {
    "name": "Floyd",
    "full": "Floyd County",
    "fips": "21071"
  },
  {
    "name": "Franklin",
    "full": "Franklin County",
    "fips": "21073"
  },
  {
    "name": "Fulton",
    "full": "Fulton County",
    "fips": "21075"
  },
  {
    "name": "Gallatin",
    "full": "Gallatin County",
    "fips": "21077"
  },
  {
    "name": "Garrard",
    "full": "Garrard County",
    "fips": "21079"
  },
  {
    "name": "Grant",
    "full": "Grant County",
    "fips": "21081"
  },
  {
    "name": "Graves",
    "full": "Graves County",
    "fips": "21083"
  },
  {
    "name": "Grayson",
    "full": "Grayson County",
    "fips": "21085"
  },
  {
    "name": "Green",
    "full": "Green County",
    "fips": "21087"
  },
  {
    "name": "Greenup",
    "full": "Greenup County",
    "fips": "21089"
  },
  {
    "name": "Hancock",
    "full": "Hancock County",
    "fips": "21091"
  },
  {
    "name": "Hardin",
    "full": "Hardin County",
    "fips": "21093"
  },
  {
    "name": "Harlan",
    "full": "Harlan County",
    "fips": "21095"
  },
  {
    "name": "Harrison",
    "full": "Harrison County",
    "fips": "21097"
  },
  {
    "name": "Hart",
    "full": "Hart County",
    "fips": "21099"
  },
  {
    "name": "Henderson",
    "full": "Henderson County",
    "fips": "21101"
  },
  {
    "name": "Henry",
    "full": "Henry County",
    "fips": "21103"
  },
  {
    "name": "Hickman",
    "full": "Hickman County",
    "fips": "21105"
  },
  {
    "name": "Hopkins",
    "full": "Hopkins County",
    "fips": "21107"
  },
  {
    "name": "Jackson",
    "full": "Jackson County",
    "fips": "21109"
  },
  {
    "name": "Jefferson",
    "full": "Jefferson County",
    "fips": "21111"
  },
  {
    "name": "Jessamine",
    "full": "Jessamine County",
    "fips": "21113"
  },
  {
    "name": "Johnson",
    "full": "Johnson County",
    "fips": "21115"
  },
  {
    "name": "Kenton",
    "full": "Kenton County",
    "fips": "21117"
  },
  {
    "name": "Knott",
    "full": "Knott County",
    "fips": "21119"
  },
  {
    "name": "Knox",
    "full": "Knox County",
    "fips": "21121"
  },
  {
    "name": "Larue",
    "full": "Larue County",
    "fips": "21123"
  },
  {
    "name": "Laurel",
    "full": "Laurel County",
    "fips": "21125"
  },
  {
    "name": "Lawrence",
    "full": "Lawrence County",
    "fips": "21127"
  },
  {
    "name": "Lee",
    "full": "Lee County",
    "fips": "21129"
  },
  {
    "name": "Leslie",
    "full": "Leslie County",
    "fips": "21131"
  },
  {
    "name": "Letcher",
    "full": "Letcher County",
    "fips": "21133"
  },
  {
    "name": "Lewis",
    "full": "Lewis County",
    "fips": "21135"
  },
  {
    "name": "Lincoln",
    "full": "Lincoln County",
    "fips": "21137"
  },
  {
    "name": "Livingston",
    "full": "Livingston County",
    "fips": "21139"
  },
  {
    "name": "Logan",
    "full": "Logan County",
    "fips": "21141"
  },
  {
    "name": "Lyon",
    "full": "Lyon County",
    "fips": "21143"
  },
  {
    "name": "Madison",
    "full": "Madison County",
    "fips": "21151"
  },
  {
    "name": "Magoffin",
    "full": "Magoffin County",
    "fips": "21153"
  },
  {
    "name": "Marion",
    "full": "Marion County",
    "fips": "21155"
  },
  {
    "name": "Marshall",
    "full": "Marshall County",
    "fips": "21157"
  },
  {
    "name": "Martin",
    "full": "Martin County",
    "fips": "21159"
  },
  {
    "name": "Mason",
    "full": "Mason County",
    "fips": "21161"
  },
  {
    "name": "McCracken",
    "full": "McCracken County",
    "fips": "21145"
  },
  {
    "name": "McCreary",
    "full": "McCreary County",
    "fips": "21147"
  },
  {
    "name": "McLean",
    "full": "McLean County",
    "fips": "21149"
  },
  {
    "name": "Meade",
    "full": "Meade County",
    "fips": "21163"
  },
  {
    "name": "Menifee",
    "full": "Menifee County",
    "fips": "21165"
  },
  {
    "name": "Mercer",
    "full": "Mercer County",
    "fips": "21167"
  },
  {
    "name": "Metcalfe",
    "full": "Metcalfe County",
    "fips": "21169"
  },
  {
    "name": "Monroe",
    "full": "Monroe County",
    "fips": "21171"
  },
  {
    "name": "Montgomery",
    "full": "Montgomery County",
    "fips": "21173"
  },
  {
    "name": "Morgan",
    "full": "Morgan County",
    "fips": "21175"
  },
  {
    "name": "Muhlenberg",
    "full": "Muhlenberg County",
    "fips": "21177"
  },
  {
    "name": "Nelson",
    "full": "Nelson County",
    "fips": "21179"
  },
  {
    "name": "Nicholas",
    "full": "Nicholas County",
    "fips": "21181"
  },
  {
    "name": "Ohio",
    "full": "Ohio County",
    "fips": "21183"
  },
  {
    "name": "Oldham",
    "full": "Oldham County",
    "fips": "21185"
  },
  {
    "name": "Owen",
    "full": "Owen County",
    "fips": "21187"
  },
  {
    "name": "Owsley",
    "full": "Owsley County",
    "fips": "21189"
  },
  {
    "name": "Pendleton",
    "full": "Pendleton County",
    "fips": "21191"
  },
  {
    "name": "Perry",
    "full": "Perry County",
    "fips": "21193"
  },
  {
    "name": "Pike",
    "full": "Pike County",
    "fips": "21195"
  },
  {
    "name": "Powell",
    "full": "Powell County",
    "fips": "21197"
  },
  {
    "name": "Pulaski",
    "full": "Pulaski County",
    "fips": "21199"
  },
  {
    "name": "Robertson",
    "full": "Robertson County",
    "fips": "21201"
  },
  {
    "name": "Rockcastle",
    "full": "Rockcastle County",
    "fips": "21203"
  },
  {
    "name": "Rowan",
    "full": "Rowan County",
    "fips": "21205"
  },
  {
    "name": "Russell",
    "full": "Russell County",
    "fips": "21207"
  },
  {
    "name": "Scott",
    "full": "Scott County",
    "fips": "21209"
  },
  {
    "name": "Shelby",
    "full": "Shelby County",
    "fips": "21211"
  },
  {
    "name": "Simpson",
    "full": "Simpson County",
    "fips": "21213"
  },
  {
    "name": "Spencer",
    "full": "Spencer County",
    "fips": "21215"
  },
  {
    "name": "Taylor",
    "full": "Taylor County",
    "fips": "21217"
  },
  {
    "name": "Todd",
    "full": "Todd County",
    "fips": "21219"
  },
  {
    "name": "Trigg",
    "full": "Trigg County",
    "fips": "21221"
  },
  {
    "name": "Trimble",
    "full": "Trimble County",
    "fips": "21223"
  },
  {
    "name": "Union",
    "full": "Union County",
    "fips": "21225"
  },
  {
    "name": "Warren",
    "full": "Warren County",
    "fips": "21227"
  },
  {
    "name": "Washington",
    "full": "Washington County",
    "fips": "21229"
  },
  {
    "name": "Wayne",
    "full": "Wayne County",
    "fips": "21231"
  },
  {
    "name": "Webster",
    "full": "Webster County",
    "fips": "21233"
  },
  {
    "name": "Whitley",
    "full": "Whitley County",
    "fips": "21235"
  },
  {
    "name": "Wolfe",
    "full": "Wolfe County",
    "fips": "21237"
  },
  {
    "name": "Woodford",
    "full": "Woodford County",
    "fips": "21239"
  }
]
```

# apps\web\src\data\localDb.ts

```ts
import Dexie, { type Table } from "dexie";

export type LocalReadState = {
  id: string;        // itemId
  readAt: string;    // ISO
};

export type LocalSavedState = {
  id: string;        // itemId
  savedAt: string;   // ISO
};

export type LocalSavedItem = {
  id: string;          // itemId
  savedAt: string;     // ISO
  title: string;
  url: string;
  author?: string | null;
  published_at?: string | null;
  summary?: string | null;
  content?: string | null;
  image_url?: string | null;
  source?: string | null;
};

export type LocalCachedItem = {
  id: string;          // itemId
  cachedAt: string;    // ISO
  title: string;
  url: string;
  author?: string | null;
  published_at?: string | null;
  summary?: string | null;
  content?: string | null;
  image_url?: string | null;
  source?: string | null;
};

class LocalDB extends Dexie {
  read!: Table<LocalReadState, string>;
  saved!: Table<LocalSavedState, string>;
  savedItems!: Table<LocalSavedItem, string>;
  cached!: Table<LocalCachedItem, string>;

  constructor() {
    super("feedreader_local");
    this.version(2).stores({
      read: "id, readAt",
      saved: "id, savedAt",
      savedItems: "id, savedAt",
      cached: "id, cachedAt"
    });
  }
}

export const localDb = new LocalDB();

export async function markRead(id: string) {
  await localDb.read.put({ id, readAt: new Date().toISOString() });
}

export async function markUnread(id: string) {
  await localDb.read.delete(id);
}

export async function isRead(id: string) {
  const row = await localDb.read.get(id);
  return !!row;
}

export async function toggleSaved(item: {
  id: string;
  title: string;
  url: string;
  author?: string | null;
  published_at?: string | null;
  summary?: string | null;
  content?: string | null;
  image_url?: string | null;
  source?: string | null;
}) {
  const existing = await localDb.savedItems.get(item.id);
  if (existing) {
    await localDb.savedItems.delete(item.id);
    await localDb.saved.delete(item.id);
    return false;
  }
  const savedAt = new Date().toISOString();
  await localDb.saved.put({ id: item.id, savedAt });
  await localDb.savedItems.put({ ...item, savedAt });
  return true;
}

export async function isSaved(id: string) {
  return !!(await localDb.savedItems.get(id) || await localDb.saved.get(id));
}

export async function listSavedItems(limit = 200) {
  return localDb.savedItems.orderBy("savedAt").reverse().limit(limit).toArray();
}

export async function cacheLastOpened(item: Omit<LocalCachedItem, "cachedAt">, maxItems = 30) {
  await localDb.cached.put({ ...item, cachedAt: new Date().toISOString() });

  // keep last N by cachedAt
  const all = await localDb.cached.orderBy("cachedAt").reverse().toArray();
  if (all.length > maxItems) {
    const toDelete = all.slice(maxItems);
    await localDb.cached.bulkDelete(toDelete.map((x) => x.id));
  }
}

export async function getCachedItem(id: string) {
  return localDb.cached.get(id);
}

export async function bulkIsRead(ids: string[]) {
  if (!ids.length) return new Map<string, boolean>();
  const rows = await localDb.read.bulkGet(ids);
  const m = new Map<string, boolean>();
  ids.forEach((id, i) => m.set(id, !!rows[i]));
  return m;
}

```

# apps\web\src\main.tsx

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./ui/App";
import "./ui/styles.css";
import { registerSW } from "virtual:pwa-register";

registerSW({
  onNeedRefresh() {
    // Minimal UX: reload prompt in-app banner
    window.dispatchEvent(new CustomEvent("pwa:need-refresh"));
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent("pwa:offline-ready"));
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

```

# apps\web\src\ui\App.tsx

```tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  getFeeds,
  getItems,
  getCounties,
  getOpenProxy,
  searchItems,
  getWeatherForecast,
  getWeatherAlerts,
  listLostFound,
  submitLostFound,
  getLostFoundUploadUrl,
  uploadLostFoundImage,
  type Feed,
  type Item,
  type LostFoundPost,
  type LostFoundType,
  type WeatherAlert,
  type WeatherForecast
} from "../data/api";
import { bulkIsRead, isSaved, listSavedItems, markRead, toggleSaved } from "../data/localDb";
import Reader from "./Reader";
import { IconBookmark, IconHeart, IconMapPin, IconMenu, IconSearch, IconSettings, IconShare, IconToday } from "./icons";
import kyCounties from "../data/ky-counties.json";

function sourceFromUrl(url: string) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function formatPublishedDate(iso?: string | null) {
  if (!iso) return "Published date unavailable";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Published date unavailable";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function stripHtml(input?: string | null) {
  if (!input) return "";
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function summarySnippet(item: Item, maxWords = 24) {
  const clean = stripHtml(item.summary || item.content || "");
  if (!clean) return "Tap to open the full story.";
  const words = clean.split(" ");
  if (words.length <= maxWords) return clean;
  return words.slice(0, maxWords).join(" ") + "...";
}

function formatFromNow(iso?: string | null) {
  if (!iso) return "Unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown time";

  const diffMs = Date.now() - d.getTime();
  const diffMinutes = Math.max(1, Math.floor(diffMs / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatPublishedDate(iso);
}

const COVERAGE_TABS = [
  { id: "today", label: "TODAY", path: "/today" },
  { id: "national", label: "NATIONAL", path: "/national" },
  { id: "weather", label: "WEATHER", path: "/weather" },
  { id: "schools", label: "SCHOOLS", path: "/schools" },
  { id: "obituaries", label: "OBITUARIES", path: "/obituaries" },
  { id: "lost-found", label: "LOST & FOUND", path: "/lost-found" }
];

const LOCAL_PREF_KEY = "my_local_county";
const SELECTED_COUNTIES_PREF_KEY = "selected_counties";
const THEME_PREF_KEY = "ui_theme";
type ThemeMode = "light" | "dark";

function getMyLocalCounty(): string {
  try {
    return (localStorage.getItem(LOCAL_PREF_KEY) || "").trim();
  } catch {
    return "";
  }
}

function setMyLocalCounty(county: string) {
  try {
    localStorage.setItem(LOCAL_PREF_KEY, county);
  } catch {
    // ignore
  }
}

function getSelectedCounties(): string[] {
  try {
    const raw = localStorage.getItem(SELECTED_COUNTIES_PREF_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const all = new Set((kyCounties as { name: string }[]).map((c) => c.name));
    return parsed
      .map((x) => String(x || "").trim())
      .filter((x) => all.has(x));
  } catch {
    return [];
  }
}

function setSelectedCounties(counties: string[]) {
  try {
    localStorage.setItem(SELECTED_COUNTIES_PREF_KEY, JSON.stringify(counties));
  } catch {
    // ignore
  }
}

function getThemeMode(): ThemeMode {
  try {
    return localStorage.getItem(THEME_PREF_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_PREF_KEY, mode);
  } catch {
    // ignore
  }
}

function applyThemeMode(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", mode);
}

export default function App() {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getThemeMode());

  useEffect(() => {
    applyThemeMode(themeMode);
    setThemeMode(themeMode);
  }, [themeMode]);

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/today" replace />} />
      <Route path="/today" element={<TodayScreen />} />
      <Route path="/national" element={<NationalScreen />} />
      <Route path="/open" element={<ExternalWebViewScreen />} />
      <Route path="/weather" element={<WeatherScreen />} />
      <Route path="/schools" element={<SchoolsScreen />} />
      <Route path="/obituaries" element={<ObituariesScreen />} />
      <Route path="/lost-found" element={<LostFoundScreen />} />
      <Route path="/my-local" element={<MyLocalScreen />} />
      <Route path="/read-later" element={<ReadLaterScreen />} />
      <Route path="/search" element={<SearchScreen />} />
      <Route path="/preferences" element={<PreferencesScreen />} />
      <Route
        path="/settings"
        element={
          <SettingsScreen
            themeMode={themeMode}
            onToggleDarkTheme={(enabled) => setThemeModeState(enabled ? "dark" : "light")}
          />
        }
      />
      <Route path="/local-settings" element={<Navigate to="/my-local" replace />} />
      <Route path="/feed/:feedId" element={<FeedScreen />} />
      <Route path="/item/:id" element={<Reader />} />
      <Route path="*" element={<Navigate to="/today" replace />} />
    </Routes>
  );
}

/** Shell: topbar + drawer + bottom nav */
function AppShell({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  const nav = useNavigate();
  const loc = useLocation();

  const [drawerOpen, setDrawerOpen] = useState(false);

  const active = (path: string) => loc.pathname === path || loc.pathname.startsWith(path + "/");
  const onTodayView = loc.pathname === "/today";

  useEffect(() => {
    setDrawerOpen(false);
  }, [loc.pathname, loc.search]);

  function open(path: string) {
    setDrawerOpen(false);
    nav(path);
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="iconBtn topMenuBtn" aria-label="Menu" onClick={() => setDrawerOpen(true)}>
          <IconMenu className="navIcon" />
        </button>

        <div className="title">{title}</div>
        <div className="topbarSpacer" />
      </header>

      {drawerOpen ? (
        <>
          <div className="drawerOverlay" onClick={() => setDrawerOpen(false)} />
          <div className="drawer" role="dialog" aria-label="Navigation">
            <div className="drawerHeader">
              Kentucky News
              <div style={{ marginLeft: "auto" }}>
                <button className="iconBtn closeBtn" onClick={() => setDrawerOpen(false)} aria-label="Close">
                  ✕
                </button>
              </div>
            </div>

            <div className="drawerList drawerNav">
              <div
                className={"drawerItem " + (onTodayView ? "active" : "")}
                onClick={() => open("/today")}
              >
                <div className="drawerLabel">Home</div>
              </div>

              <div
                className={"drawerItem " + (active("/search") ? "active" : "")}
                onClick={() => open("/search")}
              >
                <div className="drawerLabel">Search</div>
              </div>

              <div
                className={"drawerItem " + (active("/my-local") ? "active" : "")}
                onClick={() => open("/my-local")}
              >
                <div className="drawerLabel">Local News</div>
              </div>

              <div
                className={"drawerItem " + (active("/preferences") ? "active" : "")}
                onClick={() => open("/preferences")}
              >
                <div className="drawerLabel">Preferences</div>
              </div>

              <div
                className={"drawerItem " + (active("/read-later") ? "active" : "")}
                onClick={() => open("/read-later")}
              >
                <div className="drawerLabel">Saved</div>
              </div>

              <div
                className={"drawerItem " + (active("/settings") ? "active" : "")}
                onClick={() => open("/settings")}
              >
                <div className="drawerLabel">Settings</div>
              </div>
            </div>
          </div>
        </>
      ) : null}

      <div className="appFrame">
        <main className="content">{children}</main>
      </div>

      <div className="bottomNav">
        <button
          className={"navBtn " + (onTodayView ? "active" : "")}
          onClick={() => nav("/today")}
          aria-label="Home"
        >
          <IconToday className="navIcon" />
          <span className="navLabel">Home</span>
        </button>
        <button
          className={"navBtn " + (active("/search") ? "active" : "")}
          onClick={() => nav("/search")}
          aria-label="Search"
        >
          <IconSearch className="navIcon" />
          <span className="navLabel">Search</span>
        </button>
        <button
          className={"navBtn " + (active("/my-local") ? "active" : "")}
          onClick={() => nav("/my-local")}
          aria-label="Local News"
        >
          <IconMapPin className="navIcon" />
          <span className="navLabel">Local</span>
        </button>
        <button
          className={"navBtn " + (active("/preferences") ? "active" : "")}
          onClick={() => nav("/preferences")}
          aria-label="Preferences"
        >
          <IconBookmark className="navIcon" />
          <span className="navLabel">Preferences</span>
        </button>
        <button
          className={"navBtn " + (active("/read-later") ? "active" : "")}
          onClick={() => nav("/read-later")}
          aria-label="Saved"
        >
          <IconHeart className="navIcon" />
          <span className="navLabel">Saved</span>
        </button>
        <button className={"navBtn " + (active("/settings") ? "active" : "")} onClick={() => nav("/settings")} aria-label="Settings">
          <IconSettings className="navIcon" />
          <span className="navLabel">Settings</span>
        </button>
      </div>
    </div>
  );
}

function CoverageTabs() {
  const nav = useNavigate();
  const loc = useLocation();
  const isActive = (path: string) => loc.pathname === path;

  return (
    <div className="tabs">
      {COVERAGE_TABS.map((tab) => (
        <button
          key={tab.id}
          className={"tab " + (isActive(tab.path) ? "active" : "")}
          onClick={() => nav(tab.path)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function ItemCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const [readMap, setReadMap] = useState<Map<string, boolean>>(new Map());
  const [saved, setSaved] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const map = await bulkIsRead([item.id]);
      const s = await isSaved(item.id);
      if (!mounted) return;
      setReadMap(map);
      setSaved(s);
    })();
    return () => {
      mounted = false;
    };
  }, [item.id]);
  useEffect(() => {
    setImageFailed(false);
  }, [item.id, item.image_url]);

  const unread = !readMap.get(item.id);
  const src = sourceFromUrl(item.url);
  const regionChip = item.region_scope === "national" ? "National" : "Kentucky";
  const stateChips = Array.from(new Set((item.states || []).map((s) => s.toUpperCase()))).filter(
    (s) => !(item.region_scope === "ky" && s === "KY")
  );

  async function openAndMark() {
    await markRead(item.id);
    setReadMap(new Map([[item.id, true]]));
    onOpen();
  }

  async function save(e: React.MouseEvent) {
    e.stopPropagation();
    const next = await toggleSaved({
      id: item.id,
      title: item.title,
      url: item.url,
      author: item.author ?? null,
      published_at: item.published_at ?? null,
      summary: item.summary ?? null,
      content: item.content ?? null,
      image_url: item.image_url ?? null,
      source: src
    });
    setSaved(next);
  }

  return (
    <div
      className={"card postCard " + (unread ? "unread" : "")}
      onClick={openAndMark}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void openAndMark();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {item.image_url && !imageFailed ? (
        <img
          className="postImage"
          src={item.image_url}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="postImage postImageFallback">
          <div className="postImageFallbackText">{(src || "Local News").toUpperCase()}</div>
        </div>
      )}
      <div className="postBody">
        <div className="source">{src || "Source"}</div>
        <div className="chips">
          {item.region_scope ? <span className="chip">{regionChip}</span> : null}
          {stateChips.map((s) => (
            <span key={s} className="chip">{s}</span>
          ))}
          {(item.counties || []).slice(0, 3).map((c) => (
            <span key={c} className="chip">{c}</span>
          ))}
          {item.counties && item.counties.length > 3 ? <span className="chip">+{item.counties.length - 3}</span> : null}
        </div>
        <h3 className="postTitle">{item.title}</h3>
        <p className="postSummary">{summarySnippet(item)}</p>
        <div className="postFooter">
          <span className="postTime" title={item.published_at || ""}>{formatFromNow(item.published_at)}</span>
          <div className="postActions">
            <button className={"iconAction " + (saved ? "active" : "")} onClick={save} aria-label={saved ? "Saved" : "Save article"}>
              <IconHeart className="postActionIcon" />
            </button>
            <button
              className="iconAction"
              onClick={(e) => {
                e.stopPropagation();
                window.open(item.url, "_blank", "noopener,noreferrer");
              }}
              aria-label="Open source"
            >
              <IconShare className="postActionIcon" />
            </button>
          </div>
        </div>
        <div className="meta">
          <span>{formatPublishedDate(item.published_at)}</span>
        </div>
      </div>
    </div>
  );
}

function FeaturedItemCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const [readMap, setReadMap] = useState<Map<string, boolean>>(new Map());
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const map = await bulkIsRead([item.id]);
      if (!mounted) return;
      setReadMap(map);
    })();
    return () => {
      mounted = false;
    };
  }, [item.id]);
  useEffect(() => {
    setImageFailed(false);
  }, [item.id, item.image_url]);

  const unread = !readMap.get(item.id);
  const source = sourceFromUrl(item.url) || "Top story";

  async function openAndMark() {
    await markRead(item.id);
    setReadMap(new Map([[item.id, true]]));
    onOpen();
  }

  return (
    <div
      className={"featuredCard " + (unread ? "unread" : "")}
      onClick={openAndMark}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void openAndMark();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {item.image_url && !imageFailed ? (
        <img
          className="featuredImage"
          src={item.image_url}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="featuredImage featuredFallback" />
      )}
      <div className="featuredOverlay" />
      <div className="featuredContent">
        <div className="featuredSource">{source}</div>
        <h2 className="featuredTitle">{item.title}</h2>
        <p className="featuredSummary">{summarySnippet(item, 28)}</p>
        <div className="featuredReadMore">Continue reading...</div>
      </div>
    </div>
  );
}

function StoryDeck({
  items,
  onOpen,
  emptyMessage = "No stories yet."
}: {
  items: Item[];
  onOpen: (id: string) => void;
  emptyMessage?: string;
}) {
  if (!items.length) {
    return <div className="card emptyState">{emptyMessage}</div>;
  }

  const [featured, ...rest] = items;
  return (
    <>
      <FeaturedItemCard item={featured} onOpen={() => onOpen(featured.id)} />
      {rest.length ? (
        <div className="postGrid">
          {rest.map((it) => (
            <ItemCard key={it.id} item={it} onOpen={() => onOpen(it.id)} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function InfinitePager({
  hasMore,
  loading,
  onLoadMore
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void | Promise<void>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onLoadRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!hasMore || loading) return;
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void onLoadRef.current();
        }
      },
      { rootMargin: "480px 0px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading]);

  if (!hasMore) {
    return <div className="listStatus">No more stories</div>;
  }

  return (
    <div ref={ref} className="listStatus">
      {loading ? "Loading more..." : "Scroll for more"}
    </div>
  );
}

function TodayScreen() {
  const nav = useNavigate();
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const state = (q.get("state") || "").toUpperCase();
  const county = q.get("county") || "";
  const selectedCounties = useMemo(
    () => (state || county ? [] : getSelectedCounties()),
    [state, county]
  );
  const countyFilter = county ? [county] : selectedCounties;

  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await getItems({
          state: state || undefined,
          county: county || undefined,
          counties: !county ? selectedCounties : undefined,
          limit: 30
        });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, county, selectedCounties]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await getItems({
        state: state || undefined,
        county: county || undefined,
        counties: !county ? selectedCounties : undefined,
        cursor,
        limit: 30
      });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  const locationLabel = county
    ? `${county}, KY`
    : state === "KY"
      ? "Kentucky"
      : countyFilter.length
        ? `My Counties (${countyFilter.length})`
        : "";

  return (
    <AppShell title="Kentucky News">
      <CoverageTabs />

      <div className="section">
        {locationLabel ? <div className="locationBanner">Coverage: {locationLabel}</div> : null}

        {loading && !items.length ? (
          <div className="card emptyState">Loading stories...</div>
        ) : (
          <>
            <StoryDeck
              items={items}
              onOpen={(id) => nav(`/item/${id}`)}
              emptyMessage="No stories right now."
            />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function NationalScreen() {
  const nav = useNavigate();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await getItems({ scope: "national", limit: 30 });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await getItems({ scope: "national", cursor, limit: 30 });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="National">
      <CoverageTabs />
      <div className="section">
        {loading && !items.length ? (
          <div className="card emptyState">Loading stories...</div>
        ) : (
          <>
            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function FeedScreen() {
  const nav = useNavigate();
  const { feedId } = useParams();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const feeds = await getFeeds().catch(() => []);
      const f = feeds.find((x) => x.id === feedId) || null;
      if (!cancelled) setFeed(f);

      try {
        const res = await getItems({ feedId: feedId || undefined, limit: 30 });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [feedId]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await getItems({ feedId: feedId || undefined, cursor, limit: 30 });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title={feed?.name || "Feed"}>
      <div className="section">
        {loading && !items.length ? (
          <div className="card emptyState">Loading stories...</div>
        ) : (
          <>
            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function ExternalWebViewScreen() {
  const nav = useNavigate();
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const rawUrl = (q.get("url") || "").trim();
  const [loading, setLoading] = useState(false);
  const [proxyHtml, setProxyHtml] = useState("");
  const [proxyTitle, setProxyTitle] = useState("");
  const [proxyError, setProxyError] = useState("");

  let frameUrl = "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      frameUrl = parsed.toString();
    }
  } catch {
    frameUrl = "";
  }

  useEffect(() => {
    let cancelled = false;
    if (!frameUrl) return;
    (async () => {
      setLoading(true);
      setProxyError("");
      setProxyHtml("");
      try {
        const res = await getOpenProxy(frameUrl);
        if (cancelled) return;
        setProxyHtml(res.html || "");
        setProxyTitle(res.title || "");
      } catch (err: any) {
        if (!cancelled) setProxyError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [frameUrl]);

  return (
    <AppShell title="Original">
      <div className="section">
        {!frameUrl ? (
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Invalid article URL</div>
            <button className="btn" onClick={() => nav(-1)}>
              Back
            </button>
          </div>
        ) : (
          <div className="card webviewCard">
            <div className="webviewTop">
              <div className="webviewActions">
                <button className="btn" onClick={() => nav(-1)}>
                  Back
                </button>
                <a className="btn" href={frameUrl} target="_blank" rel="noreferrer">
                  Open external
                </a>
              </div>
            </div>
            {loading ? <div className="card emptyState">Loading article in app...</div> : null}
            {!loading && proxyHtml ? (
              <>
                {proxyTitle ? <div className="webviewHint">In-app view: {proxyTitle}</div> : null}
                <iframe
                  title="Original article"
                  srcDoc={proxyHtml}
                  className="webviewFrame"
                  referrerPolicy="no-referrer"
                />
              </>
            ) : null}

            {!loading && !proxyHtml ? (
              <>
                <iframe title="Original article" src={frameUrl} className="webviewFrame" referrerPolicy="no-referrer" />
                <div className="webviewHint">
                  {proxyError
                    ? `Proxy view unavailable: ${proxyError}. Showing direct frame when possible.`
                    : 'Some publishers block embedded viewing. Use "Open external" if this page does not load.'}
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ReadLaterScreen() {
  const nav = useNavigate();
  const [saved, setSaved] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewedCount, setReviewedCount] = useState(0);

  async function refresh() {
    setLoading(true);
    try {
      const rows = await listSavedItems(200);
      // Convert to Item shape
      const items: Item[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        author: r.author ?? null,
        published_at: r.published_at ?? null,
        summary: r.summary ?? null,
        content: r.content ?? null,
        image_url: r.image_url ?? null
      }));
      setSaved(items);
      const readMap = await bulkIsRead(items.map((x) => x.id));
      let reviewed = 0;
      for (const x of items) {
        if (readMap.get(x.id)) reviewed++;
      }
      setReviewedCount(reviewed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function markAllRead() {
    await Promise.all(saved.map((it) => markRead(it.id)));
    await refresh();
  }

  return (
    <AppShell title="Read Later">
      <div className="section">
        <div style={{ textAlign: "center", color: "var(--muted)", margin: "14px 0" }}>
          {loading ? "Loading…" : `You've reviewed ${reviewedCount} article${reviewedCount === 1 ? "" : "s"}`}
        </div>

        {loading ? (
          <div className="card emptyState">Loading saved stories...</div>
        ) : (
          <StoryDeck items={saved} onOpen={(id) => nav(`/item/${id}`)} emptyMessage="No saved articles yet." />
        )}

        <button className="btn block" onClick={markAllRead} disabled={!saved.length}>
          Mark All as Read
        </button>
      </div>
    </AppShell>
  );
}

function PreferencesScreen() {
  const nav = useNavigate();
  const [selectedCounties, setSelectedCountiesState] = useState<string[]>(() => getSelectedCounties());
  const allCounties = useMemo(() => (kyCounties as { name: string }[]).map((c) => c.name), []);

  function toggleCounty(name: string) {
    setSelectedCountiesState((prev) => {
      const next = prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name];
      setSelectedCounties(next);
      return next;
    });
  }

  function clearCountyPrefs() {
    setSelectedCountiesState([]);
    setSelectedCounties([]);
  }

  return (
    <AppShell title="Preferences">
      <div className="section">
        <div className="card prefCard">
          <div className="prefHeading">App</div>
          <div className="prefRow" onClick={() => nav("/settings")}>
            <div className="prefRowMeta">
              <div className="drawerLabel">Settings</div>
              <div className="prefHint">Theme and app options</div>
            </div>
          </div>
          <div className="prefRow" onClick={() => nav("/my-local")}>
            <div className="prefRowMeta">
              <div className="drawerLabel">Local News</div>
              <div className="prefHint">Set your county and local feed</div>
            </div>
          </div>
          <div className="prefRow" onClick={() => nav("/weather")}>
            <div className="prefRowMeta">
              <div className="drawerLabel">Weather</div>
              <div className="prefHint">County forecast and alerts</div>
            </div>
          </div>
        </div>

        <div className="card prefCard">
          <div className="prefHeading">County Feed Filters</div>
          <div className="prefHint" style={{ marginBottom: 10 }}>
            Select one or more counties. Home feed will show only matching county stories.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button className="btn" onClick={clearCountyPrefs} disabled={!selectedCounties.length}>
              Clear Selection
            </button>
            <button className="btn" onClick={() => nav("/today")}>
              View Home Feed
            </button>
          </div>
          <div className="countyPills">
            {allCounties.map((name) => {
              const active = selectedCounties.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  className={"countyPill " + (active ? "active" : "")}
                  onClick={() => toggleCounty(name)}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function SettingsScreen({
  themeMode,
  onToggleDarkTheme
}: {
  themeMode: ThemeMode;
  onToggleDarkTheme: (enabled: boolean) => void;
}) {
  const nav = useNavigate();

  return (
    <AppShell title="Settings">
      <div className="section">
        <div className="card prefCard">
          <div className="prefHeading">Appearance</div>
          <div className="prefRow themeRow">
            <div className="prefRowMeta">
              <div className="drawerLabel">Dark Mode</div>
              <div className="prefHint">Enable dark appearance</div>
            </div>
            <label className="themeSwitch" aria-label="Dark mode toggle">
              <input
                className="themeInput"
                type="checkbox"
                checked={themeMode === "dark"}
                onChange={(e) => onToggleDarkTheme(e.target.checked)}
              />
              <span className="themeSlider" />
            </label>
          </div>
        </div>

        <div className="card prefCard">
          <div className="prefHeading">Shortcuts</div>
          <div className="prefRow" onClick={() => nav("/my-local")}>
            <div className="prefRowMeta">
              <div className="drawerLabel">Local News</div>
              <div className="prefHint">Set your local county</div>
            </div>
          </div>
          <div className="prefRow" onClick={() => nav("/preferences")}>
            <div className="prefRowMeta">
              <div className="drawerLabel">Open Preferences</div>
              <div className="prefHint">Manage app shortcuts</div>
            </div>
          </div>
          <div className="prefRow" onClick={() => nav("/read-later")}>
            <div className="drawerLabel">Saved Articles</div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function MyLocalScreen() {
  const nav = useNavigate();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loadingCounties, setLoadingCounties] = useState(true);
  const [selected, setSelected] = useState(() => getMyLocalCounty());
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCounties(true);
      try {
        const res = await getCounties({ state: "KY", hours: 24 * 14 });
        const map: Record<string, number> = {};
        for (const row of res.counties) map[row.county] = row.count;
        if (!cancelled) setCounts(map);
      } catch {
        if (!cancelled) setCounts({});
      } finally {
        if (!cancelled) setLoadingCounties(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setItems([]);
      setCursor(null);
      return;
    }

    (async () => {
      setLoadingFeed(true);
      setItems([]);
      setCursor(null);
      try {
        const res = await getItems({ state: "KY", county: selected, hours: 24 * 14, limit: 30 });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoadingFeed(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const all = (kyCounties as { name: string }[]).map((c) => c.name);

  function choose(name: string) {
    setSelected(name);
    setMyLocalCounty(name);
  }

  async function loadMoreLocal() {
    if (!selected || !cursor || loadingFeed) return;
    setLoadingFeed(true);
    try {
      const res = await getItems({ state: "KY", county: selected, hours: 24 * 14, cursor, limit: 30 });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingFeed(false);
    }
  }

  return (
    <AppShell title="Local News">
      <CoverageTabs />
      <div className="section">
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 8 }}>Select Local County</div>
          <select
            className="searchInput"
            value={selected}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">Select county...</option>
            {all.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {selected ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
              {loadingCounties ? "Loading count..." : `${counts[selected] ?? 0} local article(s) in the last 14 days`}
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 12 }}>
          {!selected ? <div className="card emptyState">Choose a county to load your local feed.</div> : null}
          {selected && loadingFeed && !items.length ? <div className="card emptyState">Loading local stories...</div> : null}
          {selected ? (
            <>
              <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} emptyMessage="No local stories right now." />
              {items.length ? (
                <InfinitePager hasMore={Boolean(cursor)} loading={loadingFeed} onLoadMore={loadMoreLocal} />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function weatherGlyph(text: string) {
  const s = String(text || "").toLowerCase();
  if (s.includes("thunder")) return "⛈";
  if (s.includes("snow") || s.includes("sleet")) return "❄";
  if (s.includes("rain") || s.includes("shower")) return "🌧";
  if (s.includes("cloud")) return "☁";
  if (s.includes("fog") || s.includes("mist")) return "🌫";
  return "☀";
}

function WeatherScreen() {
  const nav = useNavigate();
  const [county, setCounty] = useState(() => getMyLocalCounty());
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [alerts, setAlerts] = useState<WeatherAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!county) {
      setLoading(false);
      return;
    }

    (async () => {
      setLoading(true);
      setError("");
      try {
        const [forecastRes, alertRes] = await Promise.all([
          getWeatherForecast(county, "KY"),
          getWeatherAlerts({ state: "KY", county })
        ]);
        if (cancelled) return;
        setForecast(forecastRes);
        setAlerts(alertRes.alerts || []);
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [county]);

  return (
    <AppShell title="Weather">
      <CoverageTabs />
      <div className="section">
        {!county ? (
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Choose your county first</div>
            <button className="btn primary" onClick={() => nav("/my-local")}>
              Set My County
            </button>
          </div>
        ) : null}

        {county ? (
          <div className="card weatherWidget" style={{ marginBottom: 12 }}>
            <div className="weatherTop">
              <div>
                <div className="weatherCounty">{county} County, KY</div>
                <div className="weatherSub">
                  {forecast?.periods?.[0]?.name || "Current"} {forecast?.periods?.[0]?.temperature ?? "--"}°
                  {forecast?.periods?.[0]?.temperatureUnit || "F"}
                </div>
              </div>
              <div className="weatherGlyph">{weatherGlyph(forecast?.periods?.[0]?.shortForecast || "")}</div>
            </div>
            <div className="weatherSummary">{forecast?.periods?.[0]?.shortForecast || "Forecast loading..."}</div>
            <div className="weatherActions">
              <button className="btn" onClick={() => nav("/my-local")}>
                Change County
              </button>
              <button className="btn" onClick={() => setCounty(getMyLocalCounty())}>
                Refresh
              </button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="card" style={{ padding: 14, color: "var(--muted)" }}>
            Loading weather...
          </div>
        ) : null}

        {error ? (
          <div className="card" style={{ padding: 14, color: "#b91c1c", marginBottom: 12 }}>
            {error}
          </div>
        ) : null}

        {alerts.length ? (
          <div className="card" style={{ padding: 14, marginBottom: 12, borderColor: "#f59e0b" }}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>Active Alerts</div>
            {alerts.map((a) => (
              <div key={a.id} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 800 }}>{a.headline}</div>
                <div style={{ fontSize: 13, color: "var(--muted)" }}>{a.event} • {a.severity}</div>
              </div>
            ))}
          </div>
        ) : null}

        {forecast ? (
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>Forecast</div>
            <div className="weatherPeriodGrid">
              {forecast.periods.slice(0, 8).map((p) => (
                <div key={p.name + p.startTime} className="weatherPeriodCard">
                  <div className="weatherPeriodHead">{p.name}</div>
                  <div className="weatherPeriodTemp">{p.temperature}°{p.temperatureUnit}</div>
                  <div className="weatherPeriodText">{p.shortForecast}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function ObituariesScreen() {
  const nav = useNavigate();
  const selectedCounties = useMemo(() => getSelectedCounties(), []);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await getItems({
          scope: "ky",
          category: "Kentucky - Obituaries",
          counties: selectedCounties.length ? selectedCounties : undefined,
          hours: 24 * 14,
          limit: 30
        });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCounties]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await getItems({
        scope: "ky",
        category: "Kentucky - Obituaries",
        counties: selectedCounties.length ? selectedCounties : undefined,
        hours: 24 * 14,
        cursor,
        limit: 30
      });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Obituaries">
      <CoverageTabs />
      <div className="section">
        {loading && !items.length ? (
          <div className="card emptyState">Loading obituary stories...</div>
        ) : (
          <>
            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} emptyMessage="No obituary stories right now." />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function SchoolsScreen() {
  const nav = useNavigate();
  const selectedCounties = useMemo(() => getSelectedCounties(), []);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const schoolQuery = "\"school\" OR \"schools\" OR \"district\" OR \"classroom\" OR \"student\" OR \"teacher\" OR \"university\" OR \"college\"";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await searchItems(schoolQuery, {
          scope: "ky",
          counties: selectedCounties.length ? selectedCounties : undefined,
          hours: 24 * 14,
          limit: 30
        });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCounties]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await searchItems(schoolQuery, {
        scope: "ky",
        counties: selectedCounties.length ? selectedCounties : undefined,
        hours: 24 * 14,
        cursor,
        limit: 30
      });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Schools">
      <CoverageTabs />
      <div className="section">
        {loading && !items.length ? (
          <div className="card emptyState">Loading school stories...</div>
        ) : (
          <>
            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} emptyMessage="No school stories right now." />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function LostFoundScreen() {
  const [posts, setPosts] = useState<LostFoundPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [type, setType] = useState<LostFoundType>("lost");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [county, setCounty] = useState(() => getMyLocalCounty());
  const [contactEmail, setContactEmail] = useState("");
  const [showContact, setShowContact] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const res = await listLostFound({ status: "published", county: county || undefined, limit: 50 });
      setPosts(res.posts);
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [county]);

  async function submit() {
    if (!title.trim() || !description.trim() || !county.trim() || !contactEmail.trim()) {
      setMessage("Please complete all required fields.");
      return;
    }

    setSubmitting(true);
    setMessage("");
    try {
      const imageKeys: string[] = [];
      if (file) {
        const upload = await getLostFoundUploadUrl(file.name, file.type || "application/octet-stream");
        await uploadLostFoundImage(upload.uploadUrl, file, upload.headers);
        imageKeys.push(upload.objectKey);
      }

      await submitLostFound({
        type,
        title: title.trim(),
        description: description.trim(),
        county: county.trim(),
        contactEmail: contactEmail.trim(),
        showContact,
        imageKeys
      });

      setTitle("");
      setDescription("");
      setContactEmail("");
      setShowContact(false);
      setFile(null);
      setMessage("Submission received and pending moderation.");
      await refresh();
    } catch (err: any) {
      setMessage(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell title="Lost & Found">
      <CoverageTabs />
      <div className="section">
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Submit a Listing</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button className={"btn " + (type === "lost" ? "primary" : "")} onClick={() => setType("lost")}>
              Lost
            </button>
            <button className={"btn " + (type === "found" ? "primary" : "")} onClick={() => setType("found")}>
              Found
            </button>
          </div>
          <input
            className="searchInput"
            style={{ marginBottom: 8 }}
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="searchInput"
            style={{ marginBottom: 8, minHeight: 90 }}
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            className="searchInput"
            style={{ marginBottom: 8 }}
            placeholder="County"
            value={county}
            onChange={(e) => setCounty(e.target.value)}
          />
          <input
            className="searchInput"
            style={{ marginBottom: 8 }}
            type="email"
            placeholder="Contact Email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
          />
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, color: "var(--muted)", fontSize: 13 }}>
            <input type="checkbox" checked={showContact} onChange={(e) => setShowContact(e.target.checked)} />
            Show contact email after approval
          </label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ marginBottom: 10 }}
          />
          <button className="btn primary" onClick={submit} disabled={submitting}>
            {submitting ? "Submitting..." : "Submit"}
          </button>
          {message ? <div style={{ marginTop: 10, color: "var(--muted)" }}>{message}</div> : null}
        </div>

        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Published Listings</div>
          {loading ? <div style={{ color: "var(--muted)" }}>Loading...</div> : null}
          {!loading && !posts.length ? <div style={{ color: "var(--muted)" }}>No listings found.</div> : null}
          {posts.map((p) => (
            <div key={p.id} style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 800 }}>
                {p.type === "lost" ? "Lost" : "Found"}: {p.title}
              </div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>
                {p.county}, {p.state_code}
              </div>
              <div style={{ fontSize: 14 }}>{p.description}</div>
              {p.contact_email ? (
                <div style={{ marginTop: 6, fontSize: 13, color: "var(--muted)" }}>Contact: {p.contact_email}</div>
              ) : null}
              {p.images[0] ? (
                <img
                  src={`/api/uploads/lost-found/${encodeURIComponent(p.images[0])}`}
                  alt=""
                  className="hero"
                  style={{ marginTop: 8, maxHeight: 220 }}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function SearchScreen() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"ky" | "national" | "all">("ky");
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runSearch(nextCursor?: string | null) {
    if (!q.trim()) return;
    if (nextCursor && loading) return;
    setLoading(true);
    try {
      const res = await searchItems(q.trim(), { scope, cursor: nextCursor ?? undefined, limit: 30 });
      setItems((prev) => (nextCursor ? [...prev, ...res.items] : res.items));
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Search">
      <div className="section">
        <input
          className="pill"
          style={{ width: "100%", padding: "12px 12px", borderRadius: 12, border: "1px solid var(--border)" }}
          placeholder="Find specific articles in your Feedly"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch(null);
          }}
        />

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button
            className="pill"
            style={{ flex: 1, textAlign: "center", cursor: "pointer", borderColor: scope === "ky" ? "var(--accent)" : undefined }}
            onClick={() => setScope("ky")}
          >
            Kentucky
          </button>
          <button
            className="pill"
            style={{ flex: 1, textAlign: "center", cursor: "pointer", borderColor: scope === "national" ? "var(--accent)" : undefined }}
            onClick={() => setScope("national")}
          >
            National
          </button>
          <button
            className="pill"
            style={{ flex: 1, textAlign: "center", cursor: "pointer", borderColor: scope === "all" ? "var(--accent)" : undefined }}
            onClick={() => setScope("all")}
          >
            Both
          </button>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <div className="pill" style={{ flex: 1, textAlign: "center" }}>
            Last 7 Days
          </div>
          <div className="pill" style={{ flex: 1, textAlign: "center" }}>
            Sort by Newest
          </div>
        </div>

        {!q.trim() ? (
          <div style={{ marginTop: 18, color: "var(--muted)" }}>
            <div style={{ fontWeight: 800, color: "#2563eb", marginBottom: 10 }}>Learn By Example</div>

            <div className="card" style={{ padding: 14 }}>
              <div className="pill" style={{ display: "inline-block", marginBottom: 10 }}>"Roger Federer"</div>
              <div>Put phrase inside <span style={{ color: "var(--accent)", fontWeight: 900 }}>quotes</span> for an exact match</div>

              <div style={{ height: 12 }} />

              <div className="pill" style={{ display: "inline-block", marginBottom: 10 }}>"Roger Federer" -tennis</div>
              <div>Use the <span style={{ color: "var(--accent)", fontWeight: 900 }}>minus (-)</span> operator to exclude results</div>

              <div style={{ height: 12 }} />

              <div className="pill" style={{ display: "inline-block", marginBottom: 10 }}>"Roger Federer" AND philanthropy</div>
              <div>Use <span style={{ color: "var(--accent)", fontWeight: 900 }}>AND</span> to search for multiple keywords</div>

              <div style={{ height: 12 }} />

              <div className="pill" style={{ display: "inline-block", marginBottom: 10 }}>"Roger Federer" OR "Rafael Nadal"</div>
              <div>Combine searches with <span style={{ color: "var(--accent)", fontWeight: 900 }}>OR</span></div>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <button className="btn block primary" onClick={() => runSearch(null)} disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </button>

            <div style={{ height: 12 }} />

            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} />

            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={() => runSearch(cursor)} /> : null}
            {!loading && q.trim() && !items.length ? <div className="listStatus">No results found</div> : null}
          </div>
        )}
      </div>
    </AppShell>
  );
}

```

# apps\web\src\ui\icons.tsx

```tsx
import React from "react";

type Props = { className?: string };

export function IconMenu({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

export function IconBookmark({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M7 4h10a1 1 0 0 1 1 1v16l-6-3-6 3V5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
    </svg>
  );
}

export function IconToday({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M7 3v3M17 3v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M4 8h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M6 6h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="2"/>
      <path d="M8 12h4M8 16h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

export function IconRss({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M6 18a2 2 0 1 0 0.001 0Z" stroke="currentColor" strokeWidth="2"/>
      <path d="M5 11a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M5 5a14 14 0 0 1 14 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

export function IconSearch({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" stroke="currentColor" strokeWidth="2"/>
      <path d="M16.5 16.5 21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

export function IconMore({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M5 12h.01M12 12h.01M19 12h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
    </svg>
  );
}

export function IconChevronDown({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function IconMapPin({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 21s6-5.7 6-11a6 6 0 1 0-12 0c0 5.3 6 11 6 11Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function IconHeart({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 21s-6.8-4.6-9.2-8.5c-2.5-4 0.3-9 4.7-9 2 0 3.5 1 4.5 2.4C13 4.5 14.5 3.5 16.5 3.5c4.4 0 7.2 5 4.7 9C18.8 16.4 12 21 12 21Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconShare({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M15 6h5v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M20 6 11 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M20 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconSettings({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="m19.4 15.5.3-1.5-1.4-.8a6.7 6.7 0 0 0 0-2.4l1.4-.8-.3-1.5-1.6-.3a6.8 6.8 0 0 0-1.4-1.4l.3-1.6-1.5-.3-.8 1.4a6.7 6.7 0 0 0-2.4 0l-.8-1.4-1.5.3.3 1.6a6.8 6.8 0 0 0-1.4 1.4l-1.6.3-.3 1.5 1.4.8a6.7 6.7 0 0 0 0 2.4l-1.4.8.3 1.5 1.6.3a6.8 6.8 0 0 0 1.4 1.4l-.3 1.6 1.5.3.8-1.4a6.7 6.7 0 0 0 2.4 0l.8 1.4 1.5-.3-.3-1.6a6.8 6.8 0 0 0 1.4-1.4l1.6-.3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

```

# apps\web\src\ui\Reader.tsx

```tsx
import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getItem, type Item } from "../data/api";
import { cacheLastOpened, getCachedItem, isSaved, markRead, toggleSaved } from "../data/localDb";

function toText(html: string | null | undefined) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceFromUrl(url: string) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export default function Reader() {
  const nav = useNavigate();
  const { id } = useParams();
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);
  const [fromCache, setFromCache] = useState<boolean>(false);
  const [heroImageFailed, setHeroImageFailed] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!id) return;
      setError(null);
      setFromCache(false);

      const cached = await getCachedItem(id);
      if (cached && !cancelled) {
        setItem(cached);
        setFromCache(true);
      }

      try {
        const fresh = await getItem(id);
        if (cancelled) return;
        setItem(fresh);
        setFromCache(false);

        await cacheLastOpened({
          id: fresh.id,
          title: fresh.title,
          url: fresh.url,
          author: fresh.author ?? null,
          published_at: fresh.published_at ?? null,
          summary: fresh.summary ?? null,
          content: fresh.content ?? null,
          image_url: fresh.image_url ?? null,
          source: sourceFromUrl(fresh.url)
        });

        await markRead(id);
      } catch (e: any) {
        if (cached) return;
        if (cancelled) return;
        setError(String(e?.message || e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!id) return;
      const s = await isSaved(id);
      if (mounted) setSaved(s);
    })();
    return () => {
      mounted = false;
    };
  }, [id]);

  useEffect(() => {
    setHeroImageFailed(false);
  }, [item?.id, item?.image_url]);

  async function toggle() {
    if (!id || !item) return;
    const next = await toggleSaved({
      id: item.id,
      title: item.title,
      url: item.url,
      author: item.author ?? null,
      published_at: item.published_at ?? null,
      summary: item.summary ?? null,
      content: item.content ?? null,
      image_url: item.image_url ?? null,
      source: sourceFromUrl(item.url)
    });
    setSaved(next);
  }

  const dt = item?.published_at ? new Date(item.published_at) : null;
  const dateStr = dt ? dt.toLocaleString() : "-";

  return (
    <div className="app">
      <header className="topbar">
        <button className="iconBtn" onClick={() => nav(-1)} aria-label="Back">
          ←
        </button>

        <div className="title">Article</div>
        <div className="topbarSpacer" />
      </header>

      <div className="appFrame">
        <div className="content">
          <div className="section">
            {error ? (
              <div className="card" style={{ padding: 14 }}>
                <div style={{ fontWeight: 900 }}>Error</div>
                <div style={{ color: "var(--muted)", marginTop: 8 }}>{error}</div>
              </div>
            ) : null}

            {item ? (
              <div className="card readerPad">
                <div className="readerMeta">
                  <span className="pill">{fromCache ? "offline cache" : "live"}</span>
                  <span className="pill">{item.author || "-"}</span>
                  <span className="pill">{dateStr}</span>
                </div>

                <div className="readerTitle">{item.title}</div>

                {item.image_url && !heroImageFailed ? (
                  <img className="hero" src={item.image_url} alt="" onError={() => setHeroImageFailed(true)} />
                ) : null}

                <div className="meta" style={{ marginTop: 12 }}>
                  <button className={"btn " + (saved ? "primary" : "")} onClick={toggle}>
                    {saved ? "Saved" : "Read later"}
                  </button>
                  {item.url ? (
                    <>
                      <button className="btn" onClick={() => nav(`/open?url=${encodeURIComponent(item.url)}`)}>
                        Open original in app
                      </button>
                      <a className="btn" href={item.url} target="_blank" rel="noreferrer">
                        Open external
                      </a>
                    </>
                  ) : null}
                </div>

                <div className="readerBody">
                  {toText(item.content || item.summary) ? (
                    <p>{toText(item.content || item.summary)}</p>
                  ) : (
                    <p style={{ color: "var(--muted)" }}>
                      This feed did not provide content. Use "Open original in app".
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="card" style={{ padding: 14, color: "var(--muted)" }}>
                Loading...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

```

# apps\web\src\ui\styles.css

```css
:root {
  color-scheme: light;
  --bg: #f3f4f6;
  --surface: #ffffff;
  --surface-soft: #f9fafb;
  --text: #111827;
  --muted: #6b7280;
  --border: #e5e7eb;
  --accent: #ff9800;
  --accent-soft: rgba(255, 152, 0, 0.14);
  --nav-bg: #ffffff;
  --nav-bg-soft: #f8fafc;
  --nav-text: #111827;
  --banner-bg: #fff7ed;
  --banner-border: #fed7aa;
  --banner-text: #9a3412;
  --shadow: 0 10px 24px rgba(17, 24, 39, 0.12);
}

[data-theme="dark"] {
  color-scheme: dark;
  --bg: #1f2126;
  --surface: #2a2d32;
  --surface-soft: #343840;
  --text: #f3f4f6;
  --muted: #b5bac3;
  --border: #434752;
  --accent: #ffb020;
  --accent-soft: rgba(255, 176, 32, 0.18);
  --nav-bg: #14161a;
  --nav-bg-soft: #1f2227;
  --nav-text: #f3f4f6;
  --banner-bg: rgba(255, 176, 32, 0.18);
  --banner-border: rgba(255, 176, 32, 0.35);
  --banner-text: #ffd089;
  --shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
}

* {
  box-sizing: border-box;
}

html,
body {
  height: 100%;
}

body {
  margin: 0;
  font-family: Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background: var(--bg);
  color: var(--text);
}

a {
  color: inherit;
  text-decoration: none;
}

button,
input,
textarea,
select {
  font: inherit;
}

.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  background: linear-gradient(90deg, var(--nav-bg) 0%, var(--nav-bg-soft) 55%, var(--nav-bg) 100%);
  border-bottom: 1px solid var(--border);
}

.topbar .title {
  flex: 1;
  text-align: center;
  color: var(--nav-text);
  font-size: 28px;
  font-weight: 500;
}

.topbarSpacer {
  width: 40px;
}

.iconBtn {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--nav-text);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.iconBtn:hover {
  background: var(--accent-soft);
}

.closeBtn {
  color: var(--text);
}

.appFrame {
  width: min(1160px, 100%);
  margin: 0 auto;
  flex: 1;
  min-height: 0;
  display: flex;
}

.content {
  width: 100%;
  overflow: auto;
  padding-bottom: 84px;
}

.section {
  padding: 14px;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  background: #ffffff;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

.tab {
  padding: 12px 16px 11px;
  color: #6b7280;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  cursor: pointer;
  white-space: nowrap;
  border: 0;
  border-bottom: 3px solid transparent;
  background: transparent;
}

.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.tabTail {
  margin-left: auto;
  color: #6b7280;
  font-size: 21px;
  line-height: 1;
  padding: 0 10px 2px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.emptyState {
  padding: 14px;
  color: var(--muted);
}

.locationBanner {
  margin-bottom: 12px;
  border: 1px solid var(--banner-border);
  background: var(--banner-bg);
  color: var(--banner-text);
  border-radius: 8px;
  padding: 8px 11px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.prefCard {
  padding: 12px;
  margin-bottom: 12px;
}

.prefHeading {
  margin-bottom: 10px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #4b5563;
}

.prefHint {
  font-size: 12px;
  color: var(--muted);
}

.prefRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
}

.prefRow:hover {
  background: #f3f4f6;
}

.prefRow.active {
  background: var(--accent-soft);
  border-color: rgba(255, 152, 0, 0.3);
}

.themeRow {
  cursor: default;
}

.themeRow:hover {
  background: transparent;
}

.themeSwitch {
  position: relative;
  width: 44px;
  height: 24px;
  display: inline-flex;
  align-items: center;
}

.themeInput {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.themeSlider {
  width: 100%;
  height: 100%;
  border-radius: 999px;
  background: #d1d5db;
  border: 1px solid #c2c8d1;
  position: relative;
  transition: background-color 140ms ease, border-color 140ms ease;
}

.themeSlider::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 140ms ease;
}

.themeInput:checked + .themeSlider {
  background: var(--accent);
  border-color: var(--accent);
}

.themeInput:checked + .themeSlider::after {
  transform: translateX(19px);
}

.prefRowMeta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.prefSubList {
  margin: 4px 0 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  max-height: 240px;
  overflow: auto;
}

.prefSubItem {
  border-radius: 0;
}

.countyPills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 300px;
  overflow: auto;
  padding: 2px 0;
}

.countyPill {
  border: 1px solid #d1d5db;
  border-radius: 999px;
  background: #fff;
  color: #374151;
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.countyPill:hover {
  background: #f9fafb;
}

.countyPill.active {
  border-color: rgba(255, 152, 0, 0.55);
  background: var(--accent-soft);
  color: #9a3412;
}

.drawerSectionTitle {
  padding: 8px 12px 6px;
  color: #6b7280;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.drawerLabel {
  color: var(--text);
  font-weight: 500;
}

.drawerCount {
  color: #374151;
  font-size: 13px;
  font-weight: 600;
}

.drawerBadge {
  display: inline-block;
  margin-left: 8px;
  border: 1px solid rgba(255, 152, 0, 0.35);
  background: rgba(255, 152, 0, 0.2);
  color: #9a3412;
  border-radius: 999px;
  padding: 2px 6px;
  font-size: 11px;
}

.featuredCard {
  position: relative;
  min-height: clamp(250px, 47vh, 420px);
  margin-bottom: 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  overflow: hidden;
  cursor: pointer;
  background: #222;
}

.featuredImage {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.featuredFallback {
  background: linear-gradient(135deg, #6b7280 0%, #9ca3af 100%);
}

.featuredOverlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, rgba(0, 0, 0, 0.72) 0%, rgba(0, 0, 0, 0.52) 42%, rgba(0, 0, 0, 0.18) 100%);
}

.featuredContent {
  position: absolute;
  left: clamp(16px, 3.5vw, 44px);
  right: clamp(16px, 3.5vw, 44px);
  bottom: clamp(16px, 3.3vw, 38px);
  z-index: 2;
  max-width: 760px;
}

.featuredSource {
  margin-bottom: 8px;
  color: rgba(255, 255, 255, 0.82);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.featuredTitle {
  margin: 0 0 10px;
  color: #f8fafc;
  font-size: clamp(31px, 4.3vw, 56px);
  line-height: 1.04;
  font-weight: 500;
}

.featuredSummary {
  margin: 0;
  max-width: 720px;
  color: #f3f4f6;
  font-size: clamp(19px, 2vw, 32px);
  line-height: 1.2;
  font-weight: 600;
}

.featuredReadMore {
  margin-top: 14px;
  color: var(--accent);
  font-size: 15px;
  font-weight: 700;
  text-transform: uppercase;
}

.postGrid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}

.postCard {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 130ms ease, box-shadow 130ms ease;
}

.postCard:hover {
  transform: translateY(-2px);
  box-shadow: 0 18px 28px rgba(17, 24, 39, 0.16);
}

.postCard:focus-visible,
.featuredCard:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.postImage {
  width: 100%;
  height: 170px;
  object-fit: cover;
  border-bottom: 1px solid var(--border);
  background: #e5e7eb;
}

.postImageFallback {
  background: linear-gradient(140deg, #d1d5db 0%, #e5e7eb 100%);
  display: flex;
  align-items: center;
  justify-content: center;
}

.postImageFallbackText {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #4b5563;
  text-transform: uppercase;
  text-align: center;
  padding: 0 10px;
}

.postBody {
  padding: 10px 12px 12px;
}

.source {
  color: #1d4ed8;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 6px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 3px 8px;
  border: 1px solid #d1d5db;
  color: #4b5563;
  font-size: 11px;
  line-height: 1;
}

.postTitle {
  margin: 0 0 8px;
  color: var(--text);
  font-size: 25px;
  line-height: 1.2;
  font-weight: 500;
}

.postSummary {
  margin: 0 0 10px;
  color: #374151;
  font-size: 14px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.postFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.postTime {
  color: #4b5563;
  font-size: 13px;
  font-style: italic;
  font-weight: 700;
}

.postActions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.iconAction {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: #6b7280;
  display: grid;
  place-items: center;
  cursor: pointer;
}

.iconAction:hover {
  border-color: #d1d5db;
  background: #f9fafb;
}

.iconAction.active {
  color: var(--accent);
}

.postActionIcon {
  width: 18px;
  height: 18px;
}

.meta {
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}

.btn {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 8px;
  padding: 9px 12px;
  font-weight: 600;
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  background: var(--surface-soft);
}

.btn.primary {
  border-color: rgba(255, 152, 0, 0.55);
  background: var(--accent-soft);
  color: #9a3412;
}

.btn.block {
  width: 100%;
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid #d1d5db;
  padding: 7px 11px;
  font-size: 12px;
  color: #374151;
  background: #fff;
}

.searchInput {
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text);
  padding: 10px 11px;
}

.searchInput::placeholder {
  color: #9ca3af;
}

.listStatus {
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  padding: 14px 0 22px;
}

.bottomNav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 45;
  height: 72px;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  background: var(--nav-bg);
  border-top: 1px solid var(--border);
}

.navBtn {
  border: 0;
  background: transparent;
  color: #6b7280;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
}

.navBtn.active {
  color: var(--accent);
}

.navIcon {
  width: 20px;
  height: 20px;
}

.navLabel {
  font-size: 11px;
  line-height: 1;
  font-weight: 600;
}

.drawerOverlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.42);
}

.drawer {
  position: fixed;
  z-index: 41;
  top: 0;
  left: 0;
  bottom: 0;
  width: min(86vw, 340px);
  background: #fff;
  border-right: 1px solid #d1d5db;
  box-shadow: 0 20px 34px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
}

.drawerHeader {
  min-height: 56px;
  display: flex;
  align-items: center;
  padding: 0 14px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  border-bottom: 1px solid var(--border);
}

.drawerList {
  overflow: auto;
  padding: 8px 0 14px;
}

.drawerNav .drawerItem {
  margin: 2px 10px;
  border-radius: 8px;
}

.drawerItem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 12px;
  cursor: pointer;
  border: 1px solid transparent;
}

.drawerItem:hover {
  background: #f3f4f6;
}

.drawerItem.active {
  background: var(--accent-soft);
  border-color: rgba(255, 152, 0, 0.3);
}

.drawerLabel {
  flex: 1;
}

.webviewCard {
  padding: 12px;
}

.webviewTop {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;
}

.webviewUrl {
  color: var(--muted);
  font-size: 12px;
  word-break: break-word;
}

.webviewActions {
  display: flex;
  gap: 8px;
}

.webviewFrame {
  width: 100%;
  height: 65vh;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
}

.webviewHint {
  margin-top: 10px;
  color: var(--muted);
  font-size: 12px;
}

.weatherWidget {
  padding: 14px;
  background: linear-gradient(150deg, #f8fbff 0%, #ffffff 65%);
}

.weatherTop {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.weatherCounty {
  font-size: 24px;
  font-weight: 800;
  line-height: 1.1;
}

.weatherSub {
  margin-top: 4px;
  color: var(--muted);
  font-size: 13px;
}

.weatherGlyph {
  font-size: 38px;
  line-height: 1;
}

.weatherSummary {
  margin-top: 10px;
  font-size: 14px;
  color: #1f2937;
}

.weatherActions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}

.weatherPeriodGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.weatherPeriodCard {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f9fafb;
  padding: 10px;
}

.weatherPeriodHead {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 4px;
}

.weatherPeriodTemp {
  font-size: 18px;
  font-weight: 800;
  margin-bottom: 4px;
}

.weatherPeriodText {
  font-size: 12px;
  color: #374151;
  line-height: 1.3;
}

.readerPad {
  padding: 14px;
}

.readerMeta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.readerTitle {
  margin: 8px 0 10px;
  color: var(--text);
  font-size: 28px;
  line-height: 1.2;
  font-weight: 700;
}

.readerUrl {
  color: var(--muted);
  font-size: 12px;
  word-break: break-word;
}

.readerBody {
  margin-top: 12px;
  line-height: 1.6;
  font-size: 15px;
  color: #111827;
}

.readerBody p {
  margin: 0 0 12px;
}

.hero {
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--border);
  object-fit: cover;
}

.cardRow {
  border-radius: 8px;
}

.unread .postTitle,
.unread .featuredTitle {
  font-weight: 700;
}

@media (min-width: 768px) {
  .postGrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 1040px) {
  .postGrid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 992px) {
  .topbar .title {
    font-size: 32px;
  }

  .content {
    padding-bottom: 18px;
  }

  .bottomNav {
    display: none;
  }
}

@media (max-width: 640px) {
  .topbar .title {
    font-size: 21px;
  }

  .section {
    padding: 10px;
  }

  .featuredTitle {
    font-size: clamp(26px, 9.2vw, 40px);
  }

  .featuredSummary {
    font-size: clamp(17px, 5vw, 25px);
  }

  .featuredReadMore {
    font-size: 13px;
  }

  .postTitle {
    font-size: 23px;
  }

  .postSummary {
    font-size: 14px;
  }

  .postTime {
    font-size: 13px;
  }
}

```

# apps\web\src\vite-env.d.ts

```ts
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

```

# apps\web\tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}

```

# apps\web\vite.config.ts

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Kentucky News",
        short_name: "Kentucky News",
        description: "Curated RSS reader (Feedly-style) — local device state, no accounts.",
        theme_color: "#ffffff",
        background_color: "#f3f4f6",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" }
        ]
      },
      workbox: {
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 } // 1h
            }
          },
          {
            urlPattern: ({ request }) => request.destination === "image",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "image-cache",
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 7 } // 7d
            }
          }
        ]
      }
    })
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8787"
    }
  }
});

```

# cloudflare\README.md

```md
# Cloudflare Bootstrap

This folder contains starter config for Worker migration.

- `wrangler.example.toml` is a template.
- Full migration plan is documented in `docs/09_CLOUDFLARE_DEPLOYMENT.md`.

```

# cloudflare\wrangler.example.toml

```toml
name = "ekn-api"
main = "src/index.ts"
compatibility_date = "2026-02-20"

[vars]
NWS_USER_AGENT = "EasternKentuckyNews/1.0 (admin@example.com)"

[[d1_databases]]
binding = "DB"
database_name = "ekn-prod"
database_id = "REPLACE_ME"

[[r2_buckets]]
binding = "LOST_FOUND_BUCKET"
bucket_name = "ekn-lost-found-prod"

```

# data\county-coverage-latest.json

```json
[
  {
    "county": "Adair",
    "articles_all_time": 179,
    "articles_last_7_days": 4
  },
  {
    "county": "Allen",
    "articles_all_time": 106,
    "articles_last_7_days": 24
  },
  {
    "county": "Anderson",
    "articles_all_time": 104,
    "articles_last_7_days": 12
  },
  {
    "county": "Ballard",
    "articles_all_time": 77,
    "articles_last_7_days": 0
  },
  {
    "county": "Barren",
    "articles_all_time": 135,
    "articles_last_7_days": 15
  },
  {
    "county": "Bath",
    "articles_all_time": 94,
    "articles_last_7_days": 0
  },
  {
    "county": "Bell",
    "articles_all_time": 113,
    "articles_last_7_days": 20
  },
  {
    "county": "Boone",
    "articles_all_time": 190,
    "articles_last_7_days": 15
  },
  {
    "county": "Bourbon",
    "articles_all_time": 132,
    "articles_last_7_days": 31
  },
  {
    "county": "Boyd",
    "articles_all_time": 137,
    "articles_last_7_days": 23
  },
  {
    "county": "Boyle",
    "articles_all_time": 124,
    "articles_last_7_days": 12
  },
  {
    "county": "Bracken",
    "articles_all_time": 92,
    "articles_last_7_days": 1
  },
  {
    "county": "Breathitt",
    "articles_all_time": 188,
    "articles_last_7_days": 26
  },
  {
    "county": "Breckinridge",
    "articles_all_time": 87,
    "articles_last_7_days": 0
  },
  {
    "county": "Bullitt",
    "articles_all_time": 128,
    "articles_last_7_days": 3
  },
  {
    "county": "Butler",
    "articles_all_time": 96,
    "articles_last_7_days": 2
  },
  {
    "county": "Caldwell",
    "articles_all_time": 124,
    "articles_last_7_days": 11
  },
  {
    "county": "Calloway",
    "articles_all_time": 156,
    "articles_last_7_days": 40
  },
  {
    "county": "Campbell",
    "articles_all_time": 109,
    "articles_last_7_days": 11
  },
  {
    "county": "Carlisle",
    "articles_all_time": 94,
    "articles_last_7_days": 1
  },
  {
    "county": "Carroll",
    "articles_all_time": 92,
    "articles_last_7_days": 4
  },
  {
    "county": "Carter",
    "articles_all_time": 113,
    "articles_last_7_days": 19
  },
  {
    "county": "Casey",
    "articles_all_time": 96,
    "articles_last_7_days": 4
  },
  {
    "county": "Christian",
    "articles_all_time": 125,
    "articles_last_7_days": 17
  },
  {
    "county": "Clark",
    "articles_all_time": 107,
    "articles_last_7_days": 11
  },
  {
    "county": "Clay",
    "articles_all_time": 98,
    "articles_last_7_days": 3
  },
  {
    "county": "Clinton",
    "articles_all_time": 97,
    "articles_last_7_days": 3
  },
  {
    "county": "Crittenden",
    "articles_all_time": 94,
    "articles_last_7_days": 1
  },
  {
    "county": "Cumberland",
    "articles_all_time": 86,
    "articles_last_7_days": 0
  },
  {
    "county": "Daviess",
    "articles_all_time": 171,
    "articles_last_7_days": 35
  },
  {
    "county": "Edmonson",
    "articles_all_time": 107,
    "articles_last_7_days": 13
  },
  {
    "county": "Elliott",
    "articles_all_time": 105,
    "articles_last_7_days": 0
  },
  {
    "county": "Estill",
    "articles_all_time": 89,
    "articles_last_7_days": 0
  },
  {
    "county": "Fayette",
    "articles_all_time": 727,
    "articles_last_7_days": 70
  },
  {
    "county": "Fleming",
    "articles_all_time": 94,
    "articles_last_7_days": 2
  },
  {
    "county": "Floyd",
    "articles_all_time": 114,
    "articles_last_7_days": 3
  },
  {
    "county": "Franklin",
    "articles_all_time": 220,
    "articles_last_7_days": 72
  },
  {
    "county": "Fulton",
    "articles_all_time": 81,
    "articles_last_7_days": 3
  },
  {
    "county": "Gallatin",
    "articles_all_time": 109,
    "articles_last_7_days": 0
  },
  {
    "county": "Garrard",
    "articles_all_time": 106,
    "articles_last_7_days": 0
  },
  {
    "county": "Grant",
    "articles_all_time": 100,
    "articles_last_7_days": 0
  },
  {
    "county": "Graves",
    "articles_all_time": 121,
    "articles_last_7_days": 19
  },
  {
    "county": "Grayson",
    "articles_all_time": 94,
    "articles_last_7_days": 10
  },
  {
    "county": "Green",
    "articles_all_time": 90,
    "articles_last_7_days": 0
  },
  {
    "county": "Greenup",
    "articles_all_time": 99,
    "articles_last_7_days": 3
  },
  {
    "county": "Hancock",
    "articles_all_time": 94,
    "articles_last_7_days": 12
  },
  {
    "county": "Hardin",
    "articles_all_time": 112,
    "articles_last_7_days": 20
  },
  {
    "county": "Harlan",
    "articles_all_time": 142,
    "articles_last_7_days": 13
  },
  {
    "county": "Harrison",
    "articles_all_time": 110,
    "articles_last_7_days": 1
  },
  {
    "county": "Hart",
    "articles_all_time": 115,
    "articles_last_7_days": 2
  },
  {
    "county": "Henderson",
    "articles_all_time": 112,
    "articles_last_7_days": 6
  },
  {
    "county": "Henry",
    "articles_all_time": 98,
    "articles_last_7_days": 0
  },
  {
    "county": "Hickman",
    "articles_all_time": 88,
    "articles_last_7_days": 1
  },
  {
    "county": "Hopkins",
    "articles_all_time": 122,
    "articles_last_7_days": 6
  },
  {
    "county": "Jackson",
    "articles_all_time": 106,
    "articles_last_7_days": 4
  },
  {
    "county": "Jefferson",
    "articles_all_time": 303,
    "articles_last_7_days": 73
  },
  {
    "county": "Jessamine",
    "articles_all_time": 117,
    "articles_last_7_days": 15
  },
  {
    "county": "Johnson",
    "articles_all_time": 106,
    "articles_last_7_days": 3
  },
  {
    "county": "Kenton",
    "articles_all_time": 132,
    "articles_last_7_days": 12
  },
  {
    "county": "Knott",
    "articles_all_time": 104,
    "articles_last_7_days": 10
  },
  {
    "county": "Knox",
    "articles_all_time": 119,
    "articles_last_7_days": 10
  },
  {
    "county": "Larue",
    "articles_all_time": 103,
    "articles_last_7_days": 4
  },
  {
    "county": "Laurel",
    "articles_all_time": 119,
    "articles_last_7_days": 25
  },
  {
    "county": "Lawrence",
    "articles_all_time": 100,
    "articles_last_7_days": 2
  },
  {
    "county": "Lee",
    "articles_all_time": 92,
    "articles_last_7_days": 0
  },
  {
    "county": "Leslie",
    "articles_all_time": 103,
    "articles_last_7_days": 13
  },
  {
    "county": "Letcher",
    "articles_all_time": 99,
    "articles_last_7_days": 1
  },
  {
    "county": "Lewis",
    "articles_all_time": 118,
    "articles_last_7_days": 16
  },
  {
    "county": "Lincoln",
    "articles_all_time": 112,
    "articles_last_7_days": 13
  },
  {
    "county": "Livingston",
    "articles_all_time": 96,
    "articles_last_7_days": 4
  },
  {
    "county": "Logan",
    "articles_all_time": 114,
    "articles_last_7_days": 17
  },
  {
    "county": "Lyon",
    "articles_all_time": 120,
    "articles_last_7_days": 11
  },
  {
    "county": "Madison",
    "articles_all_time": 167,
    "articles_last_7_days": 64
  },
  {
    "county": "Magoffin",
    "articles_all_time": 108,
    "articles_last_7_days": 16
  },
  {
    "county": "Marion",
    "articles_all_time": 150,
    "articles_last_7_days": 0
  },
  {
    "county": "Marshall",
    "articles_all_time": 179,
    "articles_last_7_days": 24
  },
  {
    "county": "Martin",
    "articles_all_time": 114,
    "articles_last_7_days": 13
  },
  {
    "county": "Mason",
    "articles_all_time": 125,
    "articles_last_7_days": 6
  },
  {
    "county": "McCracken",
    "articles_all_time": 195,
    "articles_last_7_days": 69
  },
  {
    "county": "McCreary",
    "articles_all_time": 96,
    "articles_last_7_days": 5
  },
  {
    "county": "McLean",
    "articles_all_time": 94,
    "articles_last_7_days": 1
  },
  {
    "county": "Meade",
    "articles_all_time": 96,
    "articles_last_7_days": 1
  },
  {
    "county": "Menifee",
    "articles_all_time": 77,
    "articles_last_7_days": 0
  },
  {
    "county": "Mercer",
    "articles_all_time": 94,
    "articles_last_7_days": 6
  },
  {
    "county": "Metcalfe",
    "articles_all_time": 100,
    "articles_last_7_days": 6
  },
  {
    "county": "Monroe",
    "articles_all_time": 105,
    "articles_last_7_days": 1
  },
  {
    "county": "Montgomery",
    "articles_all_time": 102,
    "articles_last_7_days": 3
  },
  {
    "county": "Morgan",
    "articles_all_time": 96,
    "articles_last_7_days": 1
  },
  {
    "county": "Muhlenberg",
    "articles_all_time": 104,
    "articles_last_7_days": 6
  },
  {
    "county": "Nelson",
    "articles_all_time": 112,
    "articles_last_7_days": 6
  },
  {
    "county": "Nicholas",
    "articles_all_time": 98,
    "articles_last_7_days": 1
  },
  {
    "county": "Ohio",
    "articles_all_time": 103,
    "articles_last_7_days": 6
  },
  {
    "county": "Oldham",
    "articles_all_time": 113,
    "articles_last_7_days": 4
  },
  {
    "county": "Owen",
    "articles_all_time": 105,
    "articles_last_7_days": 1
  },
  {
    "county": "Owsley",
    "articles_all_time": 106,
    "articles_last_7_days": 1
  },
  {
    "county": "Pendleton",
    "articles_all_time": 96,
    "articles_last_7_days": 0
  },
  {
    "county": "Perry",
    "articles_all_time": 117,
    "articles_last_7_days": 6
  },
  {
    "county": "Pike",
    "articles_all_time": 144,
    "articles_last_7_days": 27
  },
  {
    "county": "Powell",
    "articles_all_time": 110,
    "articles_last_7_days": 2
  },
  {
    "county": "Pulaski",
    "articles_all_time": 118,
    "articles_last_7_days": 11
  },
  {
    "county": "Robertson",
    "articles_all_time": 97,
    "articles_last_7_days": 0
  },
  {
    "county": "Rockcastle",
    "articles_all_time": 108,
    "articles_last_7_days": 5
  },
  {
    "county": "Rowan",
    "articles_all_time": 129,
    "articles_last_7_days": 15
  },
  {
    "county": "Russell",
    "articles_all_time": 116,
    "articles_last_7_days": 12
  },
  {
    "county": "Scott",
    "articles_all_time": 106,
    "articles_last_7_days": 5
  },
  {
    "county": "Shelby",
    "articles_all_time": 104,
    "articles_last_7_days": 2
  },
  {
    "county": "Simpson",
    "articles_all_time": 105,
    "articles_last_7_days": 7
  },
  {
    "county": "Spencer",
    "articles_all_time": 95,
    "articles_last_7_days": 7
  },
  {
    "county": "Taylor",
    "articles_all_time": 113,
    "articles_last_7_days": 2
  },
  {
    "county": "Todd",
    "articles_all_time": 103,
    "articles_last_7_days": 8
  },
  {
    "county": "Trigg",
    "articles_all_time": 112,
    "articles_last_7_days": 14
  },
  {
    "county": "Trimble",
    "articles_all_time": 99,
    "articles_last_7_days": 4
  },
  {
    "county": "Union",
    "articles_all_time": 97,
    "articles_last_7_days": 2
  },
  {
    "county": "Warren",
    "articles_all_time": 166,
    "articles_last_7_days": 35
  },
  {
    "county": "Washington",
    "articles_all_time": 100,
    "articles_last_7_days": 1
  },
  {
    "county": "Wayne",
    "articles_all_time": 112,
    "articles_last_7_days": 1
  },
  {
    "county": "Webster",
    "articles_all_time": 111,
    "articles_last_7_days": 2
  },
  {
    "county": "Whitley",
    "articles_all_time": 126,
    "articles_last_7_days": 16
  },
  {
    "county": "Wolfe",
    "articles_all_time": 101,
    "articles_last_7_days": 3
  },
  {
    "county": "Woodford",
    "articles_all_time": 133,
    "articles_last_7_days": 33
  }
]
```

# data\dev.sqlite

This is a binary file of the type: Binary

# data\kypress-home-feeds.json

```json
[
  {
    "county": "Boyd",
    "paper": "Greater Ashland Beacon",
    "site": "https://www.ashlandbeacon.com",
    "feedUrl": "https://www.ashlandbeacon.com/blog-feed.xml",
    "finalUrl": "https://www.ashlandbeacon.com/blog-feed.xml",
    "status": 200
  },
  {
    "county": "Kenton",
    "paper": "LINK nky",
    "site": "https://www.linknky.com",
    "feedUrl": "https://linknky.com/feed/",
    "finalUrl": "https://linknky.com/feed/",
    "status": 200
  },
  {
    "county": "Whitley",
    "paper": "Corbin/Whitley News Journal",
    "site": "https://www.thenewsjournal.net",
    "feedUrl": "https://thenewsjournal.net/feed/",
    "finalUrl": "https://thenewsjournal.net/feed/",
    "status": 200
  },
  {
    "county": "Ohio",
    "paper": "Ohio County Times-News",
    "site": "https://www.octimesnews.com",
    "feedUrl": "https://www.octimesnews.com/feed/",
    "finalUrl": "https://www.octimesnews.com/feed/",
    "status": 200
  },
  {
    "county": "LaRue",
    "paper": "LaRue County Herald News",
    "site": "https://www.laruecountyherald.com",
    "feedUrl": "http://www.pmg-ky2.com/search/?f=rss&amp;t=article&amp;c=larue&amp;l=50&amp;s=start_time&amp;sd=desc",
    "finalUrl": "https://www.pmg-ky2.com/search/?f=rss&amp;t=article&amp;c=larue&amp;l=50&amp;s=start_time&amp;sd=desc",
    "status": 200
  },
  {
    "county": "Adair",
    "paper": "Adair Progress",
    "site": "https://www.adairprogress.com",
    "feedUrl": "https://www.adairprogress.com/feed/",
    "finalUrl": "https://www.adairprogress.com/feed/",
    "status": 200
  },
  {
    "county": "Warren",
    "paper": "College Heights Herald",
    "site": "https://www.wkuherald.com",
    "feedUrl": "https://wkuherald.com/feed/",
    "finalUrl": "https://wkuherald.com/feed/",
    "status": 200
  },
  {
    "county": "Marion",
    "paper": "Lebanon Enterprise",
    "site": "https://www.lebanonenterprise.com",
    "feedUrl": "http://www.pmg-ky2.com/search/?f=rss&amp;t=article&amp;c=lebanon&amp;l=50&amp;s=start_time&amp;sd=desc",
    "finalUrl": "https://www.pmg-ky2.com/search/?f=rss&amp;t=article&amp;c=lebanon&amp;l=50&amp;s=start_time&amp;sd=desc",
    "status": 200
  },
  {
    "county": "Campbell",
    "paper": "The Northerner",
    "site": "https://www.thenortherner.com",
    "feedUrl": "https://www.thenortherner.com/feed/",
    "finalUrl": "https://www.thenortherner.com/feed/",
    "status": 200
  },
  {
    "county": "Jefferson",
    "paper": "Forward Kentucky",
    "site": "https://www.forwardky.com",
    "feedUrl": "https://www.forwardky.com/latest/rss/",
    "finalUrl": "https://www.forwardky.com/latest/rss/",
    "status": 200
  },
  {
    "county": "Green",
    "paper": "Greensburg Record Herald",
    "site": "https://www.record-herald.com",
    "feedUrl": "https://www.record-herald.com/feed/",
    "finalUrl": "https://www.record-herald.com/feed/",
    "status": 200
  },
  {
    "county": "Lawrence",
    "paper": "The Big Sandy News",
    "site": "https://www.thebigsandynews.com",
    "feedUrl": "https://thebigsandynews.com/index-rally?format=rss",
    "finalUrl": "https://thebigsandynews.com/index-rally?format=rss",
    "status": 200
  },
  {
    "county": "Fulton",
    "paper": "The Current",
    "site": "https://www.thecurrent.press",
    "feedUrl": "https://www.thecurrent.press/feed.atom",
    "finalUrl": "https://www.thecurrent.press/feed.atom",
    "status": 200
  },
  {
    "county": "Carter",
    "paper": "Carter County Times",
    "site": "https://www.cartercountytimes.com",
    "feedUrl": "https://cartercountytimes.com/feed/",
    "finalUrl": "https://cartercountytimes.com/feed/",
    "status": 200
  },
  {
    "county": "Daviess",
    "paper": "Owensboro Times",
    "site": "https://www.owensborotimes.com",
    "feedUrl": "https://www.owensborotimes.com/feed/",
    "finalUrl": "https://www.owensborotimes.com/feed/",
    "status": 200
  },
  {
    "county": "Fayette",
    "paper": "Kentucky Kernel",
    "site": "https://www.kykernel.com",
    "feedUrl": "https://kykernel.com/feed/",
    "finalUrl": "https://kykernel.com/feed/",
    "status": 200
  },
  {
    "county": "Calloway",
    "paper": "The Murray Sentinel",
    "site": "https://www.themurraysentinel.org",
    "feedUrl": "https://themurraysentinel.org/feed/",
    "finalUrl": "https://themurraysentinel.org/feed/",
    "status": 200
  },
  {
    "county": "Edmonson",
    "paper": "Edmonson News",
    "site": "https://www.jpinews.com",
    "feedUrl": "https://www.jpinews.com/feed/",
    "finalUrl": "https://www.jpinews.com/feed/",
    "status": 200
  },
  {
    "county": "Woodford",
    "paper": "Woodford Sun",
    "site": "https://www.woodfordsun.com",
    "feedUrl": "https://www.woodfordsun.com/blog-feed.xml",
    "finalUrl": "https://www.woodfordsun.com/blog-feed.xml",
    "status": 200
  },
  {
    "county": "Wayne",
    "paper": "Wayne Weekly",
    "site": "https://www.thewayneweekly.com",
    "feedUrl": "https://www.thewayneweekly.com/feed/",
    "finalUrl": "https://www.thewayneweekly.com/feed/",
    "status": 200
  },
  {
    "county": "Bourbon",
    "paper": "Bourbon County Citizen",
    "site": "https://www.bourboncountycitizen.com",
    "feedUrl": "https://www.bourboncountycitizen.com/feed/",
    "finalUrl": "https://www.bourboncountycitizen.com/feed/",
    "status": 200
  },
  {
    "county": "Webster",
    "paper": "Sebree Banner",
    "site": "https://www.cpcnewspapers.com",
    "feedUrl": "https://www.cpcnewspapers.com/feed/",
    "finalUrl": "https://www.cpcnewspapers.com/feed/",
    "status": 200
  },
  {
    "county": "Hancock",
    "paper": "Hancock Clarion",
    "site": "https://www.hancockclarion.com",
    "feedUrl": "https://www.hancockclarion.com/feed/",
    "finalUrl": "https://www.hancockclarion.com/feed/",
    "status": 200
  },
  {
    "county": "Monroe",
    "paper": "Tompkinsville News",
    "site": "https://www.tompkinsvillenews.com",
    "feedUrl": "https://www.tompkinsvillenews.com/feed/",
    "finalUrl": "https://www.tompkinsvillenews.com/feed/",
    "status": 200
  },
  {
    "county": "Lewis",
    "paper": "The Lewis County Herald",
    "site": "https://www.lewiscountyherald.com",
    "feedUrl": "https://lewiscountyherald.com/feed/",
    "finalUrl": "https://lewiscountyherald.com/feed/",
    "status": 200
  },
  {
    "county": "Magoffin",
    "paper": "Salyersville Independent",
    "site": "https://www.salyersvilleindependent.com",
    "feedUrl": "https://salyersvilleindependent.com/feed/",
    "finalUrl": "https://salyersvilleindependent.com/feed/",
    "status": 200
  },
  {
    "county": "Martin",
    "paper": "Mountain Citizen",
    "site": "https://www.mountaincitizen.com",
    "feedUrl": "https://mountaincitizen.com/feed/",
    "finalUrl": "https://mountaincitizen.com/feed/",
    "status": 200
  }
]
```

# data\kypress-valid-feeds.json

```json
[
  {
    "county": "Adair",
    "paper": "Adair Progress",
    "site": "https://www.adairprogress.com",
    "feedUrl": "https://www.adairprogress.com/rss",
    "finalUrl": "https://www.adairprogress.com/feed/",
    "status": 200
  },
  {
    "county": "Bell",
    "paper": "Middlesboro News",
    "site": "https://www.middlesboronews.com",
    "feedUrl": "https://www.middlesboronews.com/rss",
    "finalUrl": "https://middlesboronews.com/feed/",
    "status": 200
  },
  {
    "county": "Bourbon",
    "paper": "Bourbon County Citizen",
    "site": "https://www.bourboncountycitizen.com",
    "feedUrl": "https://www.bourboncountycitizen.com/rss",
    "finalUrl": "https://www.bourboncountycitizen.com/feed/",
    "status": 200
  },
  {
    "county": "Boyd",
    "paper": "Ashland Daily Independent",
    "site": "https://www.dailyindependent.com",
    "feedUrl": "https://www.dailyindependent.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "finalUrl": "https://www.dailyindependent.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "status": 200
  },
  {
    "county": "Boyle",
    "paper": "Advocate Messenger",
    "site": "https://www.amnews.com",
    "feedUrl": "https://www.amnews.com/rss",
    "finalUrl": "https://amnews.com/feed/",
    "status": 200
  },
  {
    "county": "Caldwell",
    "paper": "Princeton Times Leader",
    "site": "https://www.timesleader.net",
    "feedUrl": "https://www.timesleader.net/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "finalUrl": "https://www.timesleader.net/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "status": 200
  },
  {
    "county": "Calloway",
    "paper": "The Murray Sentinel",
    "site": "https://www.themurraysentinel.org",
    "feedUrl": "https://www.themurraysentinel.org/rss",
    "finalUrl": "https://themurraysentinel.org/feed/",
    "status": 200
  },
  {
    "county": "Campbell",
    "paper": "The Northerner",
    "site": "https://www.thenortherner.com",
    "feedUrl": "https://www.thenortherner.com/rss",
    "finalUrl": "https://www.thenortherner.com/feed/",
    "status": 200
  },
  {
    "county": "Carter",
    "paper": "Carter County Times",
    "site": "https://www.cartercountytimes.com",
    "feedUrl": "https://www.cartercountytimes.com/rss",
    "finalUrl": "https://cartercountytimes.com/feed/",
    "status": 200
  },
  {
    "county": "Christian",
    "paper": "Kentucky New Era",
    "site": "https://www.kentuckynewera.com",
    "feedUrl": "https://www.kentuckynewera.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "finalUrl": "https://www.kentuckynewera.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "status": 200
  },
  {
    "county": "Clark",
    "paper": "Winchester Sun",
    "site": "https://www.winchestersun.com",
    "feedUrl": "https://www.winchestersun.com/rss",
    "finalUrl": "https://winchestersun.com/feed/",
    "status": 200
  },
  {
    "county": "Daviess",
    "paper": "Owensboro Times",
    "site": "https://www.owensborotimes.com",
    "feedUrl": "https://www.owensborotimes.com/rss",
    "finalUrl": "https://www.owensborotimes.com/feed/",
    "status": 200
  },
  {
    "county": "Edmonson",
    "paper": "Edmonson News",
    "site": "https://www.jpinews.com",
    "feedUrl": "https://www.jpinews.com/rss",
    "finalUrl": "https://www.jpinews.com/feed/",
    "status": 200
  },
  {
    "county": "Fayette",
    "paper": "Kentucky Kernel",
    "site": "https://www.kykernel.com",
    "feedUrl": "https://www.kykernel.com/rss",
    "finalUrl": "https://kykernel.com/feed/",
    "status": 200
  },
  {
    "county": "Floyd",
    "paper": "Floyd County Chronicle and Times",
    "site": "https://www.floydct.com",
    "feedUrl": "https://www.floydct.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "finalUrl": "https://www.floydct.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "status": 200
  },
  {
    "county": "Franklin",
    "paper": "Frankfort State Journal",
    "site": "https://www.state-journal.com",
    "feedUrl": "https://www.state-journal.com/rss",
    "finalUrl": "https://state-journal.com/feed/",
    "status": 200
  },
  {
    "county": "Green",
    "paper": "Greensburg Record Herald",
    "site": "https://www.record-herald.com",
    "feedUrl": "https://www.record-herald.com/rss",
    "finalUrl": "https://www.record-herald.com/feed/",
    "status": 200
  },
  {
    "county": "Hancock",
    "paper": "Hancock Clarion",
    "site": "https://www.hancockclarion.com",
    "feedUrl": "https://www.hancockclarion.com/rss",
    "finalUrl": "https://www.hancockclarion.com/feed/",
    "status": 200
  },
  {
    "county": "Harlan",
    "paper": "Harlan Enterprise",
    "site": "https://www.harlanenterprise.net",
    "feedUrl": "https://www.harlanenterprise.net/rss",
    "finalUrl": "https://harlanenterprise.net/feed/",
    "status": 200
  },
  {
    "county": "Jefferson",
    "paper": "Forward Kentucky",
    "site": "https://www.forwardky.com",
    "feedUrl": "https://www.forwardky.com/rss",
    "finalUrl": "https://www.forwardky.com/latest/rss/",
    "status": 200
  },
  {
    "county": "Jessamine",
    "paper": "Jessamine Journal",
    "site": "https://www.jessaminejournal.com",
    "feedUrl": "https://www.jessaminejournal.com/rss",
    "finalUrl": "https://jessaminejournal.com/feed/",
    "status": 200
  },
  {
    "county": "Kenton",
    "paper": "LINK nky",
    "site": "https://www.linknky.com",
    "feedUrl": "https://www.linknky.com/rss",
    "finalUrl": "https://linknky.com/feed/",
    "status": 200
  },
  {
    "county": "Knott",
    "paper": "Troublesome Creek Times",
    "site": "https://www.troublesomecreektimes.com",
    "feedUrl": "https://www.troublesomecreektimes.com/rss",
    "finalUrl": "https://www.troublesomecreektimes.com/feed/",
    "status": 200
  },
  {
    "county": "Lewis",
    "paper": "The Lewis County Herald",
    "site": "https://www.lewiscountyherald.com",
    "feedUrl": "https://www.lewiscountyherald.com/rss",
    "finalUrl": "https://lewiscountyherald.com/feed/",
    "status": 200
  },
  {
    "county": "Lincoln",
    "paper": "Interior Journal",
    "site": "https://www.theinteriorjournal.com",
    "feedUrl": "https://www.theinteriorjournal.com/rss",
    "finalUrl": "https://theinteriorjournal.com/feed/",
    "status": 200
  },
  {
    "county": "Madison",
    "paper": "Richmond Register",
    "site": "https://www.richmondregister.com",
    "feedUrl": "https://www.richmondregister.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "finalUrl": "https://www.richmondregister.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "status": 200
  },
  {
    "county": "Magoffin",
    "paper": "Salyersville Independent",
    "site": "https://www.salyersvilleindependent.com",
    "feedUrl": "https://www.salyersvilleindependent.com/rss",
    "finalUrl": "https://salyersvilleindependent.com/feed/",
    "status": 200
  },
  {
    "county": "Marshall",
    "paper": "The Lake News",
    "site": "https://www.thelakenews.com",
    "feedUrl": "https://www.thelakenews.com/rss",
    "finalUrl": "https://www.thelakenews.com/feed/",
    "status": 200
  },
  {
    "county": "Martin",
    "paper": "Mountain Citizen",
    "site": "https://www.mountaincitizen.com",
    "feedUrl": "https://www.mountaincitizen.com/rss",
    "finalUrl": "https://mountaincitizen.com/feed/",
    "status": 200
  },
  {
    "county": "McCracken",
    "paper": "Paducah Sun",
    "site": "https://www.paducahsun.com",
    "feedUrl": "https://www.paducahsun.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "finalUrl": "https://www.paducahsun.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "status": 200
  },
  {
    "county": "Monroe",
    "paper": "Tompkinsville News",
    "site": "https://www.tompkinsvillenews.com",
    "feedUrl": "https://www.tompkinsvillenews.com/rss",
    "finalUrl": "https://www.tompkinsvillenews.com/feed/",
    "status": 200
  },
  {
    "county": "Ohio",
    "paper": "Ohio County Times-News",
    "site": "https://www.octimesnews.com",
    "feedUrl": "https://www.octimesnews.com/rss",
    "finalUrl": "https://www.octimesnews.com/feed/",
    "status": 200
  },
  {
    "county": "Simpson",
    "paper": "Franklin Favorite",
    "site": "https://www.franklinfavorite.com",
    "feedUrl": "https://www.franklinfavorite.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "finalUrl": "https://www.franklinfavorite.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "status": 200
  },
  {
    "county": "Warren",
    "paper": "Bowling Green Daily News",
    "site": "https://www.bgdailynews.com",
    "feedUrl": "https://www.bgdailynews.com/rss",
    "finalUrl": "https://bgdailynews.com/feed/",
    "status": 200
  },
  {
    "county": "Warren",
    "paper": "College Heights Herald",
    "site": "https://www.wkuherald.com",
    "feedUrl": "https://www.wkuherald.com/rss",
    "finalUrl": "https://wkuherald.com/feed/",
    "status": 200
  },
  {
    "county": "Wayne",
    "paper": "Wayne Weekly",
    "site": "https://www.thewayneweekly.com",
    "feedUrl": "https://www.thewayneweekly.com/rss",
    "finalUrl": "https://www.thewayneweekly.com/feed/",
    "status": 200
  },
  {
    "county": "Webster",
    "paper": "Sebree Banner",
    "site": "https://www.cpcnewspapers.com",
    "feedUrl": "https://www.cpcnewspapers.com/rss",
    "finalUrl": "https://www.cpcnewspapers.com/feed/",
    "status": 200
  },
  {
    "county": "Whitley",
    "paper": "Corbin/Whitley News Journal",
    "site": "https://www.thenewsjournal.net",
    "feedUrl": "https://www.thenewsjournal.net/rss",
    "finalUrl": "https://thenewsjournal.net/feed/",
    "status": 200
  }
]
```

# data\uploads\lost-found\2026-02-20-d9661780-d681-4bb8-901e-080f898ae8f2.png

This is a binary file of the type: Image

# data\uploads\lost-found\2026-02-21-acabb21e-803e-42fc-8e3e-35971cd2ae4b.png

This is a binary file of the type: Image

# docs\00_PROJECT_OVERVIEW.md

```md
# Project Overview

## Product Mission
Build the go-to mobile-first source for Kentucky news and weather, with a separate national lane, using a Feedly-style reading experience and curated sources only.

## Audience
- Kentucky residents who need county-level awareness.
- Kentucky professionals tracking local government, schools, and weather impacts.
- Readers who want a no-account, low-friction news app.

## Core Value Proposition
- Fast, clean, Feedly-like reading flow.
- County-level Kentucky sorting (state + all counties).
- Reliable weather alerts and forecast context.
- Optional community utility via moderated lost-and-found.

## In Scope (MVP to Launch)
- Curated RSS ingestion (no user-submitted RSS feeds).
- Kentucky local lane (default) with county filters and My County preference.
- Separate National lane.
- Search, Reader, Read Later, local offline support.
- Weather section backed by NOAA/NWS forecast + alerts.
- Lost-and-found submissions with moderation queue.
- Cloudflare-ready architecture (Pages + Workers + D1 + R2).

## Out of Scope (Launch)
- End-user account system.
- Personalized recommendation engine.
- Paid content/paywall bypass.
- Native mobile apps.
- Public posting without moderation.

## North-Star Metrics
- Daily active readers (DAR).
- 7-day return rate.
- Median time-to-first-contentful-item on Today screen.
- County coverage freshness (new KY items in last 2 hours).
- Weather alert delivery freshness.

## Product Principles
- No account required for reading.
- Kentucky-first always wins in prioritization.
- Trust and safety over raw posting speed.
- Performance and reliability over feature sprawl.

```

# docs\01_PRODUCT_REQUIREMENTS.md

```md
# Product Requirements

## Screens and Behaviors

### Today
- Default route `/today`.
- Shows Kentucky stories by recency.
- Supports optional query filters: `state=KY`, `county=<name>`.
- Infinite paging via cursor.

### Kentucky Local
- Drawer access to Kentucky state view and all counties.
- County counts shown from `/api/counties`.
- My Local county preference stored in localStorage.

### National
- Dedicated route `/national`.
- Only stories with `region_scope=national`.
- No county drilldown in National.

### Weather
- Route `/weather`.
- Uses My Local county by default.
- Forecast periods from NWS.
- Active alert list with severity and event.

### Search
- Route `/search`.
- Query syntax supports quoted phrases, `AND`, `OR`, `-exclude`.
- Scope picker: Kentucky, National, Both.

### Reader
- Route `/item/:id`.
- Displays cleaned content with source link.
- Supports offline fallback from local cache.

### Read Later
- Route `/read-later`.
- Device-local saved state with mark-all-read.

### Lost & Found
- Route `/lost-found`.
- Public listing shows approved posts only.
- Submission form requires: type, title, description, county, contact email.
- Optional image upload and optional contact visibility after approval.

## Interaction Requirements
- Mobile-first layout with drawer nav + bottom nav.
- Quick county switching and persistent My County setting.
- Clear loading/error states for all data-heavy screens.

## Reliability Requirements
- App remains usable if some feeds fail.
- Weather endpoint can return stale cached data if NWS is temporarily unavailable.
- Lost-and-found submission rate-limited per IP.

## Security Requirements
- Admin endpoints protected by Cloudflare Access header in production.
- Local admin fallback supported via `ADMIN_TOKEN`.
- Contact email encrypted at rest.

## Non-Functional Targets
- Initial content load under 2.5s on typical mobile 4G.
- API P95 under 600ms for core feed endpoints (excluding upstream weather latency).
- Ingestion cadence every 15 minutes.

```

# docs\02_INFORMATION_ARCHITECTURE.md

```md
# Information Architecture

## Route Map
- `/today`
- `/today?state=KY`
- `/today?state=KY&county=<county>`
- `/national`
- `/weather`
- `/read-later`
- `/search`
- `/lost-found`
- `/local-settings`
- `/feed/:feedId`
- `/item/:id`

## Navigation Model
- Drawer: Today, Read Later, National, Weather, Lost & Found, Local tools, Feed categories.
- Bottom nav: Menu, Read Later, Today, My Local, Search.
- Local county selector is reachable from drawer and Weather view.

## Content Taxonomy
- `region_scope=ky`: County-aware Kentucky content.
- `region_scope=national`: National lane only.
- `state_code` used for KY location tagging and weather.
- `county` only used for KY local filtering.

## Locality Hierarchy
1. My Local County (personal quick-access)
2. County views (all Kentucky counties)
3. Kentucky state aggregate
4. National lane

## Lost-and-Found Taxonomy
- Type: `lost` | `found`
- Status: `pending` | `approved` | `rejected`
- Visibility: public only when `approved`

## Weather Taxonomy
- State: `KY` (MVP)
- County forecast context
- Active alerts with severity and event

```

# docs\03_DATA_MODEL.md

```md
# Data Model

## Core Tables

### feeds
- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `category TEXT NOT NULL`
- `url TEXT NOT NULL`
- `state_code TEXT NOT NULL DEFAULT 'KY'`
- `region_scope TEXT NOT NULL DEFAULT 'ky'`
- `enabled INTEGER NOT NULL DEFAULT 1`
- `etag`, `last_modified`, `last_checked_at`, `created_at`

### items
- `id TEXT PRIMARY KEY`
- `title`, `url`, `guid`, `author`
- `region_scope TEXT NOT NULL DEFAULT 'ky'`
- `published_at`, `summary`, `content`, `image_url`
- `fetched_at`, `hash`
- article enrichment fields: `article_checked_at`, `article_fetch_status`, `article_text_excerpt`

### feed_items
- `(feed_id, item_id) PRIMARY KEY`

### item_locations
- `(item_id, state_code, county) PRIMARY KEY`
- `county=''` represents state-level tag

## Operational Tables
- `fetch_runs`
- `fetch_errors`

## Weather Tables

### weather_forecasts
- `id INTEGER PK`
- `state_code`, `county`
- `forecast_json`
- `fetched_at`, `expires_at`

### weather_alerts
- `id INTEGER PK`
- `alert_id`, `state_code`, `county`
- `severity`, `event`, `headline`
- `starts_at`, `ends_at`
- `raw_json`, `fetched_at`

## Lost & Found Tables

### lost_found_posts
- `id TEXT PK`
- `type ('lost'|'found')`
- `title`, `description`
- `county`, `state_code`
- `contact_email_encrypted`
- `show_contact`
- `status ('pending'|'approved'|'rejected')`
- `submitted_at`, `approved_at`, `rejected_at`
- `expires_at`, `moderation_note`

### lost_found_images
- `id TEXT PK`
- `post_id FK -> lost_found_posts`
- `r2_key`, `width`, `height`, `created_at`

### lost_found_reports
- `id TEXT PK`
- `post_id FK -> lost_found_posts`
- `reason`, `reporter_ip_hash`, `created_at`

### admin_audit_log
- `id TEXT PK`
- `actor_email`
- `action`, `entity_type`, `entity_id`
- `payload_json`, `created_at`

## Retention Defaults
- Forecast cache: 7 days
- Alert cache: 48 hours
- Lost-and-found post expiry: 30 days unless renewed
- Ingestion logs retained until manual cleanup policy introduced

```

# docs\04_API_SPEC.md

```md
# API Specification

Base URL (local): `http://127.0.0.1:8787`

## Public Endpoints

### GET /api/health
- Returns service liveness.

### GET /api/feeds
- Query: `scope=ky|national|all` (default `all`)
- Returns enabled feed definitions including `region_scope`.

### GET /api/items
- Query:
  - `scope=ky|national|all` (default `ky`)
  - `feedId?`, `state?`, `county?`, `hours?`, `cursor?`, `limit?`
- Notes:
  - `state/county` filters are valid only for KY scope.

### GET /api/items/:id
- Returns one item.

### GET /api/counties
- Query: `state=KY`, `hours?`
- Returns county counts for KY stories.

### GET /api/search
- Query:
  - `q` required
  - `scope=ky|national|all`
  - `state?`, `county?`, `hours?`, `cursor?`, `limit?`

### GET /api/weather/forecast
- Query: `state=KY`, `county` required
- Returns county forecast periods.

### GET /api/weather/alerts
- Query: `state=KY`, `county?`
- Returns active alerts list.

### GET /api/lost-found
- Query: `type?`, `county?`, `status?`, `limit?`
- Public callers can only access published (`approved`) listings.

### POST /api/lost-found/submissions
- Body:
  - `type`, `title`, `description`, `county`, `state=KY`, `contactEmail`
  - `showContact?`, `imageKeys?`, `turnstileToken?`
- Creates `pending` post.

### POST /api/lost-found/:id/report
- Body: `reason`
- Creates abuse/safety report.

### POST /api/uploads/lost-found-url
- Body: `filename`, `mimeType`
- Returns one-time upload target metadata.

### PUT /api/uploads/lost-found/:key
- Binary upload endpoint for image bytes.

### GET /api/uploads/lost-found/:key
- Returns uploaded image bytes.

## Admin Endpoints

Authentication:
- Production: Cloudflare Access header `cf-access-authenticated-user-email`.
- Local fallback: `x-admin-token` matching `ADMIN_TOKEN`.

### GET /api/admin/lost-found
- Query: `status=pending|approved|rejected`, `limit?`
- Returns moderation queue.

### POST /api/admin/lost-found/:id/approve
- Body: `showContact?`, `note?`

### POST /api/admin/lost-found/:id/reject
- Body: `reason`

### POST /api/admin/feeds/reload
- Triggers one-off ingester run.

## Error Model
- `400` invalid query/payload
- `401` admin auth required
- `404` not found
- `429` rate-limited
- `502` upstream weather error
- `500` internal server error

```

# docs\05_INGESTION_PIPELINE.md

```md
# Ingestion Pipeline

## Runtime
- Service: `apps/ingester/src/ingester.mjs`
- Schedule: every 15 minutes (configurable via `INGEST_INTERVAL_MINUTES`).
- Local one-shot: `npm run ingest:once`

## Flow
1. Load enabled feeds from `feeds`.
2. Fetch each feed with conditional headers (`If-None-Match`, `If-Modified-Since`).
3. Parse RSS items.
4. Build deterministic item ID and hash.
5. Upsert item and link `feed_items`.
6. If feed is KY scope:
   - Tag item with state-level location.
   - Attempt county detection from title/summary/content.
   - If no county found, fetch article body and retry county detection.
7. Record run status and errors.

## Dedupe Strategy
- Primary ID from URL/guid/title+date hash.
- Upsert by item ID prevents duplicate rows across runs.
- `feed_items` join tracks feed-source mapping.

## Scope Strategy
- Feed `region_scope` drives item `region_scope`.
- KY items are location-tagged.
- National items are not inserted into county-tag tables.

## Failure Handling
- Per-feed errors are logged to `fetch_errors`; pipeline continues.
- Top-level run status written to `fetch_runs`.
- Endpoint `/api/admin/feeds/reload` allows manual recovery trigger.

## Planned Improvements
- Health score per feed source.
- Failure streak alerts.
- Dead feed auto-disable policy (manual confirmation).
- Enhanced content extraction for weak RSS summaries.

```

# docs\06_PWA_SPEC.md

```md
# PWA Specification

## Stack
- Vite + React + `vite-plugin-pwa`
- Service Worker generated via Workbox.

## Installability
- Manifest served at `manifest.webmanifest`.
- Standalone display mode.
- Icons: 192 and 512 PNG.

## Caching Strategy
- API routes (`/api/*`): `NetworkFirst`, 1-hour TTL.
- Images: `StaleWhileRevalidate`, 7-day TTL.
- Static assets precached by Workbox.

## Offline Behavior
- Reader uses local Dexie cache for last-opened items.
- Read and saved state stored locally (no account sync).
- Previously fetched lists/images remain available based on SW cache.

## Update UX
- `registerSW` uses prompt mode.
- App emits `pwa:need-refresh` and `pwa:offline-ready` events.
- UI can present refresh/ready banners.

## Performance Budgets
- Mobile LCP target: < 2.5s
- JS bundle baseline monitored each build.
- API list endpoint target: P95 < 600ms local/network permitting.

## Hardening Checklist
- Add explicit update banner UI.
- Add stale content timestamp in Today/National lists.
- Add cache bust strategy for image corruption edge cases.
- Validate offline-first behavior on iOS Safari and Android Chrome.

```

# docs\07_WEATHER_SPEC.md

```md
# Weather Specification

## Source of Truth
- NOAA / National Weather Service API (`api.weather.gov`).

## Forecast Flow
1. Resolve KY county zone by name.
2. Resolve county geometry centroid.
3. Fetch point metadata from `/points/{lat},{lon}`.
4. Use forecast URL from points response.
5. Cache normalized forecast in `weather_forecasts`.

## Alert Flow
1. Fetch active alerts for KY from `/alerts/active?area=KY`.
2. Filter by county name (if county provided).
3. Cache alert payloads in `weather_alerts`.
4. Purge old alerts (>48h).

## API Contracts
- `GET /api/weather/forecast?state=KY&county=<county>`
- `GET /api/weather/alerts?state=KY&county=<county>`

## UX Rules
- Weather defaults to My Local county.
- Display active alert cards above forecast blocks.
- If live fetch fails and cache exists, return stale payload with warning.

## Refresh Cadence
- On-demand via route requests (current implementation).
- Planned scheduled refresh every 10 minutes in cloud runtime.

## Known Constraints
- County matching is string-based; naming mismatches can cause misses.
- NWS latency can vary; stale fallback is required for resilience.

```

# docs\08_LOST_FOUND_SPEC.md

```md
# Lost and Found Specification

## Goals
- Provide a practical community utility without requiring user accounts.
- Prevent abuse through mandatory moderation and basic anti-spam controls.

## Submission Workflow
1. User fills form: `type`, `title`, `description`, `county`, `contactEmail`.
2. Optional image uploaded via upload URL handshake.
3. Submission saved as `pending` in `lost_found_posts`.
4. Contact email encrypted at rest.

## Moderation Workflow
1. Admin opens queue (`/api/admin/lost-found?status=pending`).
2. Admin approves or rejects each post.
3. Approved posts become publicly visible.
4. Rejected posts remain private with moderation note.
5. All actions logged to `admin_audit_log`.

## Visibility Rules
- Public listing endpoint returns approved posts only.
- Contact email shown publicly only when `show_contact=1`.
- Admin queue always sees decrypted contact email.

## Abuse Controls
- Submission rate limit: 5 per IP per hour.
- Public reporting endpoint for problematic posts.
- Optional Turnstile enforcement gate (`REQUIRE_TURNSTILE=1`).

## Media Handling
- Upload metadata via `/api/uploads/lost-found-url`.
- Binary image upload via `PUT /api/uploads/lost-found/:key`.
- Local dev stores files under `data/uploads/lost-found`.
- Cloud target: R2 object storage with signed URLs.

## Lifecycle
- Default expiry: 30 days from submission.
- Future enhancement: admin renew/archive actions.

```

# docs\09_CLOUDFLARE_DEPLOYMENT.md

```md
# Cloudflare Deployment

## Target Topology
- Cloudflare Pages: web frontend (`apps/web` build output).
- Cloudflare Workers:
  - API worker (Fastify-equivalent route contracts).
  - Scheduled ingest worker.
- D1: relational data store.
- R2: lost-and-found images.
- Cloudflare Access: protect `/admin` routes.

## Environments
- `local`: Node + SQLite + local file uploads.
- `staging`: Pages + Workers + D1 (staging DB) + R2 (staging bucket).
- `production`: Pages + Workers + D1 (prod DB) + R2 (prod bucket).

## Required Secrets/Vars
- `NWS_USER_AGENT`
- `LOCAL_DATA_ENCRYPTION_KEY` (worker equivalent secret)
- `ADMIN_EMAIL` (optional local fallback)
- `TURNSTILE_SECRET` (when enabled)
- D1 binding names and R2 bucket bindings

## Migration Plan
1. Export SQLite schema as D1 SQL migration.
2. Implement API worker route parity with existing Node API.
3. Implement ingest worker with cron trigger (every 15 minutes).
4. Implement weather refresh cron (every 10 minutes).
5. Wire image upload flow from local disk to R2 signed uploads.
6. Switch Pages API proxy to worker domain.

## Access Control
- Use Cloudflare Access policy (email/org restrictions).
- Worker validates Access identity header for admin endpoints.

## Rollout Checklist
- Staging smoke tests pass for all primary routes.
- Ingestion and weather schedules confirmed in logs.
- Lost-and-found upload and moderation verified end-to-end.
- PWA install/update validated on staging domain.
- Production cutover with rollback path documented.

```

# docs\10_ROADMAP.md

```md
# Roadmap

## Timeline (Single Developer)

| Milestone | Target | Build Scope | Exit Criteria |
|---|---|---|---|
| M0 Baseline | Week 1 | Canonical app paths, schema alignment, docs baseline | One canonical web/API path, no structural blockers |
| M1 Kentucky Core | Weeks 2-3 | KY nav polish, list reliability, reader/read-later hardening | KY browsing stable on mobile |
| M2 National Lane | Week 4 | National feeds + dedicated `/national` lane | National stories visible without polluting KY filters |
| M3 Weather Hub | Week 5 | NWS forecast + alerts + weather screen | County weather and alerts operational |
| M4 Lost & Found MVP | Weeks 6-7 | Submission, media upload, moderation endpoints | Submit -> moderate -> publish works |
| M5 PWA Hardening | Week 8 | Offline and update UX polish, cache tuning | PWA installable and resilient offline |
| M6 Cloudflare Migration | Weeks 9-10 | Worker + D1 + R2 parity | Staging cloud parity achieved |
| M7 Launch Readiness | Week 11 | Runbooks, dashboards, QA, content governance | Soft launch go/no-go checklist complete |

## Priority Queue
1. Stabilize all new endpoints with basic smoke tests.
2. Add weather severity banner on Today/Kentucky.
3. Add admin UI shell for moderation and feed diagnostics.
4. Implement Cloudflare worker parity and deployment automation.
5. Complete policy pages and legal/compliance baseline.

## Definition of Done (Launch)
- KY + National + Weather + Lost & Found are functional in production.
- Ingestion and weather jobs are monitored and alerting.
- Moderation SLA and escalation process documented.
- PWA install/update behavior validated on major mobile browsers.

```

# docs\11_OPERATIONS_RUNBOOK.md

```md
# Operations Runbook

## Daily Checks
- Verify ingest success in latest `fetch_runs` row.
- Review `fetch_errors` for repeated feed failures.
- Verify weather endpoints return current data.
- Check pending lost-and-found moderation queue size.

## Incident Playbooks

### Ingestion Failure Spike
1. Trigger manual reload: `POST /api/admin/feeds/reload`.
2. Inspect `fetch_errors` for top failing feeds.
3. Disable broken feeds temporarily if needed.
4. Confirm new items flowing again.

### Weather API Outage
1. Confirm endpoint returns stale fallback, not hard failure.
2. Notify operators that data may be stale.
3. Monitor NWS recovery and clear warning status.

### Moderation Backlog
1. Prioritize posts older than 2 hours.
2. Reject obvious spam/unsafe submissions first.
3. Log unusual abuse patterns and add blocks/rate rules.

### Abuse Report Surge
1. Query `lost_found_reports` grouped by `post_id`.
2. Unpublish or reject affected post(s).
3. Document action in `admin_audit_log`.

## Monitoring Metrics
- Ingest success rate.
- New items in last 2 hours (KY and National).
- API route latency and error rate.
- Weather endpoint freshness.
- Lost-and-found queue age.

## Alert Thresholds
- No successful ingest in > 30 minutes.
- API 5xx > 2% for 5 minutes.
- Weather fetch failures for > 30 minutes.
- Pending moderation older than 2 hours.

## Backup and Recovery
- Local: periodic copy of `data/dev.sqlite`.
- Cloud: D1 export schedule + R2 lifecycle policy.
- Validate restore process quarterly.

## Governance
- Keep moderation policy, privacy policy, and terms current.
- Maintain takedown contact and escalation owner.

```

# docs\README.md

```md
# Documentation Index

- `00_PROJECT_OVERVIEW.md`
- `01_PRODUCT_REQUIREMENTS.md`
- `02_INFORMATION_ARCHITECTURE.md`
- `03_DATA_MODEL.md`
- `04_API_SPEC.md`
- `05_INGESTION_PIPELINE.md`
- `06_PWA_SPEC.md`
- `07_WEATHER_SPEC.md`
- `08_LOST_FOUND_SPEC.md`
- `09_CLOUDFLARE_DEPLOYMENT.md`
- `10_ROADMAP.md`
- `11_OPERATIONS_RUNBOOK.md`

```

# feeds.seed.json

```json
[
  {
    "id": "ky-wlky-top",
    "name": "WLKY Top Stories",
    "category": "Kentucky - TV",
    "url": "https://www.wlky.com/topstories-rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-lex18",
    "name": "LEX18 Headlines",
    "category": "Kentucky - TV",
    "url": "https://www.lex18.com/index.rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wtvq-local",
    "name": "ABC36 (WTVQ) Local News",
    "category": "Kentucky - TV",
    "url": "https://www.wtvq.com/category/local-news/feed",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-spectrum-lou",
    "name": "Spectrum News Louisville Headlines",
    "category": "Kentucky - Local",
    "url": "https://spectrumlocalnews.com/services/contentfeed.ky%7Clouisville%7Cnews.landing.rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wdrb-search",
    "name": "WDRB News (RSS Search)",
    "category": "Kentucky - Local",
    "url": "https://www.wdrb.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wpsd-search",
    "name": "WPSD Local 6 (RSS Search)",
    "category": "Kentucky - Local",
    "url": "https://www.wpsdlocal6.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-kentuckylantern-politics",
    "name": "Kentucky Lantern Politics",
    "category": "Kentucky - Politics",
    "url": "https://kentuckylantern.com/category/politics/feed/",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-forwardky",
    "name": "ForwardKY Latest",
    "category": "Kentucky - Politics",
    "url": "https://www.forwardky.com/latest/rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-uknow-campus",
    "name": "UKNow Campus News",
    "category": "Kentucky - Education",
    "url": "https://uknow.uky.edu/feeds/section/347/rss.xml",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-uknow-happenings",
    "name": "UKNow Happenings",
    "category": "Kentucky - Events",
    "url": "https://uknow.uky.edu/feeds/section/426/rss.xml",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-lex18-news",
    "name": "LEX18 News",
    "category": "Kentucky - TV",
    "url": "https://www.lex18.com/news.rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-lex18-weather",
    "name": "LEX18 Weather",
    "category": "Kentucky - Weather",
    "url": "https://www.lex18.com/weather.rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wtvq-weather",
    "name": "ABC36 (WTVQ) Weather",
    "category": "Kentucky - Weather",
    "url": "https://www.wtvq.com/category/weather/feed/",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-whas-news",
    "name": "WHAS11 News",
    "category": "Kentucky - TV",
    "url": "https://www.whas11.com/feeds/syndication/rss/news",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-whas-weather",
    "name": "WHAS11 Weather",
    "category": "Kentucky - Weather",
    "url": "https://www.whas11.com/feeds/syndication/rss/weather",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wfpl",
    "name": "WFPL Louisville",
    "category": "Kentucky - Radio",
    "url": "https://wfpl.org/feed/",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-kentuckytoday",
    "name": "Kentucky Today",
    "category": "Kentucky - Statewide",
    "url": "https://www.kentuckytoday.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-kentuckynewera",
    "name": "Kentucky New Era",
    "category": "Kentucky - Local",
    "url": "https://www.kentuckynewera.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-timesleader",
    "name": "The Times Leader",
    "category": "Kentucky - Local",
    "url": "https://www.timesleader.net/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-dailyindependent",
    "name": "Daily Independent",
    "category": "Kentucky - Local",
    "url": "https://www.dailyindependent.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wcpo-state",
    "name": "WCPO Kentucky",
    "category": "Kentucky - Regional",
    "url": "https://www.wcpo.com/news/state/state-kentucky.rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wowk-kentucky",
    "name": "WOWK Kentucky",
    "category": "Kentucky - Regional",
    "url": "https://www.wowktv.com/news/kentucky/feed/",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "nat-nyt-home",
    "name": "New York Times - Home Page",
    "category": "National - General",
    "url": "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    "state_code": "US",
    "region_scope": "national",
    "enabled": 1
  },
  {
    "id": "nat-npr-news",
    "name": "NPR - News",
    "category": "National - General",
    "url": "https://feeds.npr.org/1001/rss.xml",
    "state_code": "US",
    "region_scope": "national",
    "enabled": 1
  },
  {
    "id": "nat-bbc-us-canada",
    "name": "BBC - US and Canada",
    "category": "National - General",
    "url": "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml",
    "state_code": "US",
    "region_scope": "national",
    "enabled": 1
  },
  {
    "id": "nat-cnn-top",
    "name": "CNN - Top Stories",
    "category": "National - General",
    "url": "https://rss.cnn.com/rss/edition.rss",
    "state_code": "US",
    "region_scope": "national",
    "enabled": 1
  },
  {
    "id": "nat-cbs-main",
    "name": "CBS News - Top",
    "category": "National - General",
    "url": "https://www.cbsnews.com/latest/rss/main",
    "state_code": "US",
    "region_scope": "national",
    "enabled": 1
  },
  {
    "id": "ky-county-adair-adair-progress",
    "name": "Adair Progress",
    "category": "Kentucky - County Papers",
    "url": "https://www.adairprogress.com/feed",
    "state_code": "KY",
    "default_county": "Adair",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-bell-middlesboro-news",
    "name": "Middlesboro News",
    "category": "Kentucky - County Papers",
    "url": "https://middlesboronews.com/feed",
    "state_code": "KY",
    "default_county": "Bell",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-bourbon-bourbon-county-citizen",
    "name": "Bourbon County Citizen",
    "category": "Kentucky - County Papers",
    "url": "https://www.bourboncountycitizen.com/feed",
    "state_code": "KY",
    "default_county": "Bourbon",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-boyle-advocate-messenger",
    "name": "Advocate Messenger",
    "category": "Kentucky - County Papers",
    "url": "https://amnews.com/feed",
    "state_code": "KY",
    "default_county": "Boyle",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-calloway-the-murray-sentinel",
    "name": "The Murray Sentinel",
    "category": "Kentucky - County Papers",
    "url": "https://themurraysentinel.org/feed",
    "state_code": "KY",
    "default_county": "Calloway",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-campbell-the-northerner",
    "name": "The Northerner",
    "category": "Kentucky - County Papers",
    "url": "https://www.thenortherner.com/feed",
    "state_code": "KY",
    "default_county": "Campbell",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-carter-carter-county-times",
    "name": "Carter County Times",
    "category": "Kentucky - County Papers",
    "url": "https://cartercountytimes.com/feed",
    "state_code": "KY",
    "default_county": "Carter",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-clark-winchester-sun",
    "name": "Winchester Sun",
    "category": "Kentucky - County Papers",
    "url": "https://winchestersun.com/feed",
    "state_code": "KY",
    "default_county": "Clark",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-daviess-owensboro-times",
    "name": "Owensboro Times",
    "category": "Kentucky - County Papers",
    "url": "https://www.owensborotimes.com/feed",
    "state_code": "KY",
    "default_county": "Daviess",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-edmonson-edmonson-news",
    "name": "Edmonson News",
    "category": "Kentucky - County Papers",
    "url": "https://www.jpinews.com/feed",
    "state_code": "KY",
    "default_county": "Edmonson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-fayette-kentucky-kernel",
    "name": "Kentucky Kernel",
    "category": "Kentucky - County Papers",
    "url": "https://kykernel.com/feed",
    "state_code": "KY",
    "default_county": "Fayette",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-floyd-floyd-county-chronicle",
    "name": "Floyd County Chronicle and Times",
    "category": "Kentucky - County Papers",
    "url": "https://www.floydct.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Floyd",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-franklin-frankfort-state-journa",
    "name": "Frankfort State Journal",
    "category": "Kentucky - County Papers",
    "url": "https://state-journal.com/feed",
    "state_code": "KY",
    "default_county": "Franklin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-green-greensburg-record-hera",
    "name": "Greensburg Record Herald",
    "category": "Kentucky - County Papers",
    "url": "https://www.record-herald.com/feed",
    "state_code": "KY",
    "default_county": "Green",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-hancock-hancock-clarion",
    "name": "Hancock Clarion",
    "category": "Kentucky - County Papers",
    "url": "https://www.hancockclarion.com/feed",
    "state_code": "KY",
    "default_county": "Hancock",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-harlan-harlan-enterprise",
    "name": "Harlan Enterprise",
    "category": "Kentucky - County Papers",
    "url": "https://harlanenterprise.net/feed",
    "state_code": "KY",
    "default_county": "Harlan",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-jessamine-jessamine-journal",
    "name": "Jessamine Journal",
    "category": "Kentucky - County Papers",
    "url": "https://jessaminejournal.com/feed",
    "state_code": "KY",
    "default_county": "Jessamine",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-kenton-link-nky",
    "name": "LINK nky",
    "category": "Kentucky - County Papers",
    "url": "https://linknky.com/feed",
    "state_code": "KY",
    "default_county": "Kenton",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-knott-troublesome-creek-time",
    "name": "Troublesome Creek Times",
    "category": "Kentucky - County Papers",
    "url": "https://www.troublesomecreektimes.com/feed",
    "state_code": "KY",
    "default_county": "Knott",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-lewis-the-lewis-county-heral",
    "name": "The Lewis County Herald",
    "category": "Kentucky - County Papers",
    "url": "https://lewiscountyherald.com/feed",
    "state_code": "KY",
    "default_county": "Lewis",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-lincoln-interior-journal",
    "name": "Interior Journal",
    "category": "Kentucky - County Papers",
    "url": "https://theinteriorjournal.com/feed",
    "state_code": "KY",
    "default_county": "Lincoln",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-madison-richmond-register",
    "name": "Richmond Register",
    "category": "Kentucky - County Papers",
    "url": "https://www.richmondregister.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Madison",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-magoffin-salyersville-independe",
    "name": "Salyersville Independent",
    "category": "Kentucky - County Papers",
    "url": "https://salyersvilleindependent.com/feed",
    "state_code": "KY",
    "default_county": "Magoffin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-marshall-the-lake-news",
    "name": "The Lake News",
    "category": "Kentucky - County Papers",
    "url": "https://www.thelakenews.com/feed",
    "state_code": "KY",
    "default_county": "Marshall",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-martin-mountain-citizen",
    "name": "Mountain Citizen",
    "category": "Kentucky - County Papers",
    "url": "https://mountaincitizen.com/feed",
    "state_code": "KY",
    "default_county": "Martin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-mccracken-paducah-sun",
    "name": "Paducah Sun",
    "category": "Kentucky - County Papers",
    "url": "https://www.paducahsun.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "McCracken",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-monroe-tompkinsville-news",
    "name": "Tompkinsville News",
    "category": "Kentucky - County Papers",
    "url": "https://www.tompkinsvillenews.com/feed",
    "state_code": "KY",
    "default_county": "Monroe",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-ohio-ohio-county-times-news",
    "name": "Ohio County Times-News",
    "category": "Kentucky - County Papers",
    "url": "https://www.octimesnews.com/feed",
    "state_code": "KY",
    "default_county": "Ohio",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-simpson-franklin-favorite",
    "name": "Franklin Favorite",
    "category": "Kentucky - County Papers",
    "url": "https://www.franklinfavorite.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Simpson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-warren-bowling-green-daily-ne",
    "name": "Bowling Green Daily News",
    "category": "Kentucky - County Papers",
    "url": "https://bgdailynews.com/feed",
    "state_code": "KY",
    "default_county": "Warren",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-warren-college-heights-herald",
    "name": "College Heights Herald",
    "category": "Kentucky - County Papers",
    "url": "https://wkuherald.com/feed",
    "state_code": "KY",
    "default_county": "Warren",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-wayne-wayne-weekly",
    "name": "Wayne Weekly",
    "category": "Kentucky - County Papers",
    "url": "https://www.thewayneweekly.com/feed",
    "state_code": "KY",
    "default_county": "Wayne",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-webster-sebree-banner",
    "name": "Sebree Banner",
    "category": "Kentucky - County Papers",
    "url": "https://www.cpcnewspapers.com/feed",
    "state_code": "KY",
    "default_county": "Webster",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-whitley-corbin-whitley-news-jo",
    "name": "Corbin/Whitley News Journal",
    "category": "Kentucky - County Papers",
    "url": "https://thenewsjournal.net/feed",
    "state_code": "KY",
    "default_county": "Whitley",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-boyd-greater-ashland-beacon",
    "name": "Greater Ashland Beacon",
    "category": "Kentucky - County Papers",
    "url": "https://www.ashlandbeacon.com/blog-feed.xml",
    "state_code": "KY",
    "default_county": "Boyd",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-larue-larue-county-herald-ne",
    "name": "LaRue County Herald News",
    "category": "Kentucky - County Papers",
    "url": "https://www.pmg-ky2.com/search/?f=rss&t=article&c=larue&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "LaRue",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-marion-lebanon-enterprise",
    "name": "Lebanon Enterprise",
    "category": "Kentucky - County Papers",
    "url": "https://www.pmg-ky2.com/search/?f=rss&t=article&c=lebanon&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Marion",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-lawrence-the-big-sandy-news",
    "name": "The Big Sandy News",
    "category": "Kentucky - County Papers",
    "url": "https://thebigsandynews.com/index-rally?format=rss",
    "state_code": "KY",
    "default_county": "Lawrence",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-fulton-the-current",
    "name": "The Current",
    "category": "Kentucky - County Papers",
    "url": "https://www.thecurrent.press/feed.atom",
    "state_code": "KY",
    "default_county": "Fulton",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-woodford-woodford-sun",
    "name": "Woodford Sun",
    "category": "Kentucky - County Papers",
    "url": "https://www.woodfordsun.com/blog-feed.xml",
    "state_code": "KY",
    "default_county": "Woodford",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-adair",
    "name": "Adair County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Adair%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Adair",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-allen",
    "name": "Allen County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Allen%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Allen",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-anderson",
    "name": "Anderson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Anderson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Anderson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-ballard",
    "name": "Ballard County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Ballard%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Ballard",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-barren",
    "name": "Barren County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Barren%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Barren",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-bath",
    "name": "Bath County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Bath%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Bath",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-bell",
    "name": "Bell County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Bell%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Bell",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-boone",
    "name": "Boone County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Boone%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Boone",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-bourbon",
    "name": "Bourbon County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Bourbon%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Bourbon",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-boyd",
    "name": "Boyd County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Boyd%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Boyd",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-boyle",
    "name": "Boyle County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Boyle%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Boyle",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-bracken",
    "name": "Bracken County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Bracken%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Bracken",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-breathitt",
    "name": "Breathitt County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Breathitt%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Breathitt",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-breckinridge",
    "name": "Breckinridge County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Breckinridge%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Breckinridge",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-bullitt",
    "name": "Bullitt County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Bullitt%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Bullitt",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-butler",
    "name": "Butler County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Butler%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Butler",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-caldwell",
    "name": "Caldwell County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Caldwell%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Caldwell",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-calloway",
    "name": "Calloway County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Calloway%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Calloway",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-campbell",
    "name": "Campbell County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Campbell%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Campbell",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-carlisle",
    "name": "Carlisle County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Carlisle%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Carlisle",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-carroll",
    "name": "Carroll County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Carroll%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Carroll",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-carter",
    "name": "Carter County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Carter%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Carter",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-casey",
    "name": "Casey County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Casey%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Casey",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-christian",
    "name": "Christian County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Christian%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Christian",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-clark",
    "name": "Clark County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Clark%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Clark",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-clay",
    "name": "Clay County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Clay%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Clay",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-clinton",
    "name": "Clinton County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Clinton%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Clinton",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-crittenden",
    "name": "Crittenden County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Crittenden%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Crittenden",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-cumberland",
    "name": "Cumberland County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Cumberland%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Cumberland",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-daviess",
    "name": "Daviess County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Daviess%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Daviess",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-edmonson",
    "name": "Edmonson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Edmonson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Edmonson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-elliott",
    "name": "Elliott County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Elliott%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Elliott",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-estill",
    "name": "Estill County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Estill%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Estill",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-fayette",
    "name": "Fayette County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Fayette%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Fayette",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-fleming",
    "name": "Fleming County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Fleming%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Fleming",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-floyd",
    "name": "Floyd County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Floyd%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Floyd",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-franklin",
    "name": "Franklin County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Franklin%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Franklin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-fulton",
    "name": "Fulton County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Fulton%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Fulton",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-gallatin",
    "name": "Gallatin County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Gallatin%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Gallatin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-garrard",
    "name": "Garrard County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Garrard%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Garrard",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-grant",
    "name": "Grant County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Grant%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Grant",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-graves",
    "name": "Graves County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Graves%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Graves",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-grayson",
    "name": "Grayson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Grayson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Grayson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-green",
    "name": "Green County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Green%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Green",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-greenup",
    "name": "Greenup County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Greenup%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Greenup",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-hancock",
    "name": "Hancock County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Hancock%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Hancock",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-hardin",
    "name": "Hardin County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Hardin%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Hardin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-harlan",
    "name": "Harlan County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Harlan%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Harlan",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-harrison",
    "name": "Harrison County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Harrison%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Harrison",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-hart",
    "name": "Hart County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Hart%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Hart",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-henderson",
    "name": "Henderson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Henderson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Henderson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-henry",
    "name": "Henry County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Henry%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Henry",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-hickman",
    "name": "Hickman County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Hickman%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Hickman",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-hopkins",
    "name": "Hopkins County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Hopkins%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Hopkins",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-jackson",
    "name": "Jackson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Jackson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Jackson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-jefferson",
    "name": "Jefferson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Jefferson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Jefferson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-jessamine",
    "name": "Jessamine County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Jessamine%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Jessamine",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-johnson",
    "name": "Johnson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Johnson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Johnson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-kenton",
    "name": "Kenton County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Kenton%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Kenton",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-knott",
    "name": "Knott County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Knott%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Knott",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-knox",
    "name": "Knox County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Knox%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Knox",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-larue",
    "name": "Larue County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Larue%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Larue",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-laurel",
    "name": "Laurel County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Laurel%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Laurel",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-lawrence",
    "name": "Lawrence County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Lawrence%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Lawrence",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-lee",
    "name": "Lee County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Lee%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Lee",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-leslie",
    "name": "Leslie County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Leslie%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Leslie",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-letcher",
    "name": "Letcher County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Letcher%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Letcher",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-lewis",
    "name": "Lewis County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Lewis%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Lewis",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-lincoln",
    "name": "Lincoln County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Lincoln%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Lincoln",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-livingston",
    "name": "Livingston County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Livingston%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Livingston",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-logan",
    "name": "Logan County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Logan%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Logan",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-lyon",
    "name": "Lyon County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Lyon%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Lyon",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-madison",
    "name": "Madison County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Madison%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Madison",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-magoffin",
    "name": "Magoffin County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Magoffin%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Magoffin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-marion",
    "name": "Marion County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Marion%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Marion",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-marshall",
    "name": "Marshall County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Marshall%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Marshall",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-martin",
    "name": "Martin County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Martin%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Martin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-mason",
    "name": "Mason County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Mason%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Mason",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-mccracken",
    "name": "McCracken County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=McCracken%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "McCracken",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-mccreary",
    "name": "McCreary County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=McCreary%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "McCreary",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-mclean",
    "name": "McLean County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=McLean%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "McLean",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-meade",
    "name": "Meade County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Meade%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Meade",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-menifee",
    "name": "Menifee County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Menifee%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Menifee",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-mercer",
    "name": "Mercer County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Mercer%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Mercer",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-metcalfe",
    "name": "Metcalfe County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Metcalfe%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Metcalfe",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-monroe",
    "name": "Monroe County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Monroe%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Monroe",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-montgomery",
    "name": "Montgomery County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Montgomery%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Montgomery",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-morgan",
    "name": "Morgan County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Morgan%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Morgan",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-muhlenberg",
    "name": "Muhlenberg County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Muhlenberg%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Muhlenberg",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-nelson",
    "name": "Nelson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Nelson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Nelson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-nicholas",
    "name": "Nicholas County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Nicholas%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Nicholas",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-ohio",
    "name": "Ohio County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Ohio%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Ohio",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-oldham",
    "name": "Oldham County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Oldham%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Oldham",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-owen",
    "name": "Owen County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Owen%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Owen",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-owsley",
    "name": "Owsley County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Owsley%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Owsley",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-pendleton",
    "name": "Pendleton County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Pendleton%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Pendleton",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-perry",
    "name": "Perry County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Perry%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Perry",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-pike",
    "name": "Pike County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Pike%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Pike",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-powell",
    "name": "Powell County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Powell%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Powell",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-pulaski",
    "name": "Pulaski County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Pulaski%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Pulaski",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-robertson",
    "name": "Robertson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Robertson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Robertson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-rockcastle",
    "name": "Rockcastle County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Rockcastle%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Rockcastle",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-rowan",
    "name": "Rowan County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Rowan%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Rowan",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-russell",
    "name": "Russell County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Russell%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Russell",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-scott",
    "name": "Scott County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Scott%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Scott",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-shelby",
    "name": "Shelby County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Shelby%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Shelby",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-simpson",
    "name": "Simpson County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Simpson%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Simpson",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-spencer",
    "name": "Spencer County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Spencer%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Spencer",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-taylor",
    "name": "Taylor County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Taylor%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Taylor",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-todd",
    "name": "Todd County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Todd%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Todd",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-trigg",
    "name": "Trigg County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Trigg%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Trigg",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-trimble",
    "name": "Trimble County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Trimble%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Trimble",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-union",
    "name": "Union County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Union%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Union",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-warren",
    "name": "Warren County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Warren%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Warren",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-washington",
    "name": "Washington County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Washington%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Washington",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-wayne",
    "name": "Wayne County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Wayne%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Wayne",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-webster",
    "name": "Webster County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Webster%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Webster",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-whitley",
    "name": "Whitley County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Whitley%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Whitley",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-wolfe",
    "name": "Wolfe County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Wolfe%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Wolfe",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-woodford",
    "name": "Woodford County Watch",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Woodford%20County%20Kentucky&format=rss",
    "state_code": "KY",
    "default_county": "Woodford",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-kentuckylantern-latest",
    "name": "Kentucky Lantern Latest",
    "category": "Kentucky - Statewide",
    "url": "https://kentuckylantern.com/feed/",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wave3-arc",
    "name": "WAVE 3 News",
    "category": "Kentucky - TV",
    "url": "https://www.wave3.com/arc/outboundfeeds/rss/?outputType=xml",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wkyt-arc",
    "name": "WKYT News",
    "category": "Kentucky - TV",
    "url": "https://www.wkyt.com/arc/outboundfeeds/rss/?outputType=xml",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wymt-arc",
    "name": "WYMT News",
    "category": "Kentucky - Regional",
    "url": "https://www.wymt.com/arc/outboundfeeds/rss/?outputType=xml",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wbko-arc",
    "name": "WBKO News",
    "category": "Kentucky - TV",
    "url": "https://www.wbko.com/arc/outboundfeeds/rss/?outputType=xml",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wkms-regional-news",
    "name": "WKMS Regional News",
    "category": "Kentucky - Radio",
    "url": "https://www.wkms.org/rss.xml",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-nkytribune",
    "name": "NKyTribune",
    "category": "Kentucky - Local",
    "url": "https://www.nkytribune.com/feed/",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-lane-report",
    "name": "Lane Report",
    "category": "Kentucky - Business",
    "url": "https://www.lanereport.com/feed/",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-kentuckycom-homepage",
    "name": "Kentucky.com Headlines",
    "category": "Kentucky - Statewide",
    "url": "https://feeds.mcclatchy.com/kentucky/stories",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-messenger-inquirer",
    "name": "Messenger-Inquirer",
    "category": "Kentucky - Local",
    "url": "https://www.messenger-inquirer.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-shelby-sentinel-news",
    "name": "Sentinel-News",
    "category": "Kentucky - County Papers",
    "url": "https://www.pmg-ky1.com/search/?f=rss&t=article&c=sentinel_news&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Shelby",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-oldham-oldham-era",
    "name": "Oldham Era",
    "category": "Kentucky - County Papers",
    "url": "https://www.pmg-ky1.com/search/?f=rss&t=article&c=oldham_era&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Oldham",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-grant-grant-county-news",
    "name": "Grant County News",
    "category": "Kentucky - County Papers",
    "url": "https://www.pmg-ky3.com/search/?f=rss&t=article&c=grantco&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Grant",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-pike-appalachian-news-express",
    "name": "Appalachian News-Express",
    "category": "Kentucky - County Papers",
    "url": "https://www.news-expressky.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc&k%5B%5D=%23topstory",
    "state_code": "KY",
    "default_county": "Pike",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wsaz-arc",
    "name": "WSAZ Tri-State News",
    "category": "Kentucky - Regional",
    "url": "https://www.wsaz.com/arc/outboundfeeds/rss/?outputType=xml",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-lpm-news-rss",
    "name": "LPM News",
    "category": "Kentucky - Radio",
    "url": "https://www.lpm.org/news.rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-county-trigg-cadiz-record",
    "name": "Cadiz Record",
    "category": "Kentucky - County Papers",
    "url": "https://www.kentuckynewera.com/search/?f=rss&t=article&c=cadiz_record&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Trigg",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-obits-statewide-watch",
    "name": "Kentucky Obituaries Watch",
    "category": "Kentucky - Obituaries",
    "url": "https://www.bing.com/news/search?q=Kentucky%20obituaries&format=rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-obits-dailyindependent",
    "name": "Daily Independent Obituaries",
    "category": "Kentucky - Obituaries",
    "url": "https://www.dailyindependent.com/search/?f=rss&t=article&c=obituaries&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Boyd",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-obits-paducahsun",
    "name": "Paducah Sun Obituaries",
    "category": "Kentucky - Obituaries",
    "url": "https://www.paducahsun.com/search/?f=rss&t=article&c=obituaries&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "McCracken",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-obits-newsenterprise",
    "name": "News-Enterprise Obituaries",
    "category": "Kentucky - Obituaries",
    "url": "https://www.thenewsenterprise.com/search/?f=rss&t=article&c=obituaries&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Hardin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-obits-messenger-inquirer",
    "name": "Messenger-Inquirer Obituaries",
    "category": "Kentucky - Obituaries",
    "url": "https://www.messenger-inquirer.com/search/?f=rss&t=article&c=obituaries&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Daviess",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-obits-kentuckynewera",
    "name": "Kentucky New Era Obituaries",
    "category": "Kentucky - Obituaries",
    "url": "https://www.kentuckynewera.com/search/?f=rss&t=article&c=obituaries&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Christian",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-obits-richmondregister",
    "name": "Richmond Register Obituaries",
    "category": "Kentucky - Obituaries",
    "url": "https://www.richmondregister.com/search/?f=rss&t=article&c=obituaries&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Madison",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-obits-news-expressky",
    "name": "News-Express Obituaries",
    "category": "Kentucky - Obituaries",
    "url": "https://www.news-expressky.com/search/?f=rss&t=article&c=obituaries&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "Pike",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-ballard-wickliffe",
    "name": "Ballard County Watch (Wickliffe)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Wickliffe%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Ballard",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-elliott-sandy-hook",
    "name": "Elliott County Watch (Sandy Hook)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Sandy%20Hook%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Elliott",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-gallatin-warsaw",
    "name": "Gallatin County Watch (Warsaw)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Warsaw%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Gallatin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-garrard-lancaster",
    "name": "Garrard County Watch (Lancaster)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Lancaster%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Garrard",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-marion-lebanon",
    "name": "Marion County Watch (Lebanon)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Lebanon%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Marion",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-trimble-bedford",
    "name": "Trimble County Watch (Bedford)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Bedford%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Trimble",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-ballard-lacenter",
    "name": "Ballard County Watch (La Center)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=La%20Center%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Ballard",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-elliott-isonville",
    "name": "Elliott County Watch (Isonville)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Isonville%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Elliott",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-gallatin-sparta",
    "name": "Gallatin County Watch (Sparta)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Sparta%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Gallatin",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-watch-garrard-paint-lick",
    "name": "Garrard County Watch (Paint Lick)",
    "category": "Kentucky - County Watch",
    "url": "https://www.bing.com/news/search?q=Paint%20Lick%20Kentucky%20news&format=rss",
    "state_code": "KY",
    "default_county": "Garrard",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-wbontv",
    "name": "WBONTV Local News",
    "category": "Kentucky - Local",
    "url": "https://wbontv.com/feed/",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-mclean-county-journal",
    "name": "McLean County Journal",
    "category": "Kentucky - County Papers",
    "url": "https://www.messenger-inquirer.com/search/?f=rss&t=article&c=mclean_county&l=50&s=start_time&sd=desc",
    "state_code": "KY",
    "default_county": "McLean",
    "region_scope": "ky",
    "enabled": 1
  },
  {
    "id": "ky-business-lexington",
    "name": "Business Lexington",
    "category": "Kentucky - Business",
    "url": "https://smileypete.com/business/index.rss",
    "state_code": "KY",
    "region_scope": "ky",
    "enabled": 1
  }
]

```

# FULL_ARCHITECTURE.md

```md
# Full Architecture

Canonical architecture docs:

- `docs/02_INFORMATION_ARCHITECTURE.md`
- `docs/03_DATA_MODEL.md`
- `docs/09_CLOUDFLARE_DEPLOYMENT.md`
- `docs/11_OPERATIONS_RUNBOOK.md`

```

# index.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0" />
    <title>FeedReader Workspace</title>
    <style>
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        background: #f6f7f9;
        color: #111827;
      }
      .wrap {
        max-width: 760px;
        margin: 56px auto;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        padding: 20px;
      }
      h1 { margin: 0 0 10px; font-size: 22px; }
      p { margin: 8px 0; line-height: 1.45; }
      code {
        background: #f3f4f6;
        padding: 2px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <h1>FeedReader local workspace</h1>
      <p>The active frontend is the Vite app in <code>apps/web</code>.</p>
      <p>Start everything with <code>npm run dev</code> and open <code>http://localhost:5173</code>.</p>
      <p>This root page intentionally does not run an app to avoid dual-frontend confusion.</p>
    </main>
  </body>
</html>

```

# INGESTER_PIPELINE.md

```md
# Ingester Pipeline

Pipeline documentation moved to:

- `docs/05_INGESTION_PIPELINE.md`

Implementation:
- `apps/ingester/src/ingester.mjs`
- `apps/ingester/src/util.mjs`

```

# LOCATION_TAGGING.md

```md
# Location Tagging

Location tagging is defined in:

- `docs/05_INGESTION_PIPELINE.md`
- `apps/ingester/src/ingester.mjs`

Current behavior:
- Kentucky feeds receive state + county tags.
- National feeds do not enter county navigation.

```

# package.json

```json
{
  "name": "feedly-clone-local",
  "private": true,
  "workspaces": [
    "apps/*"
  ],
  "scripts": {
    "dev": "concurrently -n api,ingester,web -c auto \"npm run dev -w apps/api\" \"npm run dev -w apps/ingester\" \"npm run dev -w apps/web\"",
    "db:reset": "node scripts/reset-db.mjs",
    "feeds:seed": "node scripts/seed-feeds.mjs",
    "seed:feeds": "npm run feeds:seed",
    "ingest:once": "node apps/ingester/src/ingester.mjs --once",
    "dev:setup": "npm run db:reset && npm run feeds:seed",
    "lint": "echo \"(optional) add eslint later\""
  },
  "devDependencies": {
    "concurrently": "^9.0.0"
  }
}

```

# PLAN.md

```md
# Kentucky + National FeedReader PWA Completion Plan (Feedly-Style, No Accounts)

## Summary
Goal: finish a production-ready PWA that feels like Feedly, focuses on Kentucky county-level news plus a separate national lane, adds weather and moderated lost-and-found, and migrates from local Node/SQLite to Cloudflare Pages + Workers + D1/R2.  
Success: stable ingest, fast mobile UX, accurate county sorting for Kentucky, working weather hub, safe user submissions, and cloud deployment with admin controls.

## Locked Product Decisions
1. Launch sequence: Kentucky depth first, then national lane.
2. National model: separate National section, not mixed into county navigation.
3. Weather v1: NOAA/NWS forecasts + alerts.
4. Lost & Found moderation: pre-approval required before publish.
5. Lost & Found contact policy: email collected; hidden until approved/public choice.
6. Admin access: Cloudflare Access-protected `/admin`.
7. Delivery pace: single developer, staged MVP increments.

## Documentation Package To Create
1. `docs/00_PROJECT_OVERVIEW.md`: mission, audience, north-star metrics, out-of-scope.
2. `docs/01_PRODUCT_REQUIREMENTS.md`: detailed UX requirements for Home, County, National, Weather, Search, Reader, Lost & Found.
3. `docs/02_INFORMATION_ARCHITECTURE.md`: route map, navigation model, taxonomy (KY county vs national scope).
4. `docs/03_DATA_MODEL.md`: ERD, table schemas, indexes, retention policies.
5. `docs/04_API_SPEC.md`: endpoint contracts, request/response examples, error model, auth model for admin.
6. `docs/05_INGESTION_PIPELINE.md`: feed sourcing, dedupe, tagging, retries, failure handling.
7. `docs/06_PWA_SPEC.md`: offline behavior, cache policies, install/update UX, performance budgets.
8. `docs/07_WEATHER_SPEC.md`: NWS integration, county mapping, alert severity logic, refresh cadence.
9. `docs/08_LOST_FOUND_SPEC.md`: submission workflow, moderation workflow, media handling, safety and abuse controls.
10. `docs/09_CLOUDFLARE_DEPLOYMENT.md`: Pages, Workers, D1, R2, Access, secrets, environments, rollout checklist.
11. `docs/10_ROADMAP.md`: milestone timeline, deliverables, acceptance gates, launch checklist.
12. `docs/11_OPERATIONS_RUNBOOK.md`: monitoring, incident response, feed failures, moderation SOPs.

## Product Scope (Decision Complete)
1. Primary sections: `Today`, `Kentucky`, `My County`, `National`, `Weather`, `Read Later`, `Search`, `Lost & Found`.
2. Feed model: curated feeds only; no user-provided RSS; no end-user accounts.
3. Personalization: device-local preferences only (`My County`, read/saved state, optional push subscription later).
4. Kentucky navigation: state view + all 120 counties.
5. National navigation: one dedicated lane with source/category filters, no county drilldown.
6. Reader behavior: in-app clean read view + open original.
7. Lost & Found behavior: anonymous submission with required email + photo(s), admin review before public listing.

## Target Technical Architecture
1. Frontend: `apps/web` React + TypeScript + Vite PWA kept as canonical client.
2. Local development backend: keep current Fastify API + Node ingester until cloud parity.
3. Cloud production backend: Worker API service + Worker scheduled ingester service.
4. Datastores: D1 for structured data, R2 for lost-and-found images, local Dexie for client read/saved/cache state.
5. Security controls: Turnstile on public submissions, Cloudflare Access for admin, server-side rate limits.
6. Deployment: Pages for web, Workers for API/ingester, separate `dev` and `prod` environments.
7. Repository cleanup: retire root scaffold app (`src/*`, root `index.html`) after migration to avoid dual frontends.

## Public APIs / Interfaces / Types (Additions and Changes)
1. `GET /api/feeds`: add `region_scope` in response (`ky` | `national`).
2. `GET /api/items`: add query `scope=ky|national|all` default `ky`.
3. `GET /api/items`: preserve `state`/`county` filters for KY scope only.
4. `GET /api/weather/forecast?state=KY&county=<name>`: county forecast summary + periods.
5. `GET /api/weather/alerts?state=KY&county=<name>`: active alerts relevant to county.
6. `GET /api/lost-found?type=lost|found&county=&status=published`: public board listing.
7. `POST /api/lost-found/submissions`: create pending submission with metadata and contact email.
8. `POST /api/uploads/lost-found-url`: issue signed upload URL for R2 object key.
9. `GET /api/admin/lost-found?status=pending|approved|rejected`: moderation queue (Access protected).
10. `POST /api/admin/lost-found/:id/approve`: publish pending submission.
11. `POST /api/admin/lost-found/:id/reject`: reject submission with reason.
12. `POST /api/admin/feeds/reload`: force feed reload and ingest health check.
13. New shared TypeScript contracts: `NewsScope`, `LocationTag`, `WeatherForecast`, `WeatherAlert`, `LostFoundSubmission`, `LostFoundPost`, `ModerationDecision`.

## Data Model Changes
1. `feeds`: add `region_scope TEXT NOT NULL DEFAULT 'ky'`.
2. `items`: add `region_scope TEXT NOT NULL DEFAULT 'ky'`.
3. `weather_forecasts`: county, forecast JSON, fetched_at, expires_at.
4. `weather_alerts`: alert_id, county, severity, event, headline, starts_at, ends_at, raw JSON.
5. `lost_found_posts`: id, type, title, description, county, state_code, contact_email_encrypted, status, submitted_at, approved_at, expires_at.
6. `lost_found_images`: id, post_id, r2_key, width, height, created_at.
7. `lost_found_reports`: id, post_id, reason, reporter_ip_hash, created_at.
8. `admin_audit_log`: id, actor_email, action, entity_type, entity_id, payload_json, created_at.
9. Indexes: county + status indexes for weather and lost/found; recency indexes for feeds/items queries.
10. Retention defaults: weather forecasts 7 days, alerts until 48h after end, lost/found auto-expire after 30 days unless renewed.

## Delivery Roadmap (Single-Dev, Staged)
| Milestone | Target | Build Scope | Documentation Output | Exit Criteria |
|---|---|---|---|---|
| M0 Baseline | Week 1 | Canonicalize `apps/web`, inventory feeds, remove duplicate frontend risk, add env matrix | `00`, `09`, `10` first drafts | Local stack stable with one canonical frontend path |
| M1 Kentucky Core Finish | Weeks 2-3 | Feedly-like UI polish, county-first navigation polish, performance pass, API hardening | `01`, `02`, `06` | KY browsing/search/reader/read-later fully reliable on mobile |
| M2 National Lane | Week 4 | Add curated national feeds, `scope` support, National section UI | `01`, `04`, `05` updates | National stories visible in separate lane without breaking KY flows |
| M3 Weather Hub | Week 5 | NWS county forecasts and alerts, Weather section, severe-alert banner on Today/KY | `07`, `04` updates | Weather data refreshes automatically and county weather pages work |
| M4 Lost & Found MVP | Weeks 6-7 | Submission form, image upload, pending moderation queue, approved board pages | `08`, `04`, `11` updates | End-to-end submit → approve → publish flow works safely |
| M5 PWA Hardening | Week 8 | Offline strategy tuning, cache invalidation, install/update UX, Lighthouse fixes | `06`, `11` updates | PWA installable, key screens usable offline, update flow predictable |
| M6 Cloudflare Migration | Weeks 9-10 | Worker API + ingester parity, D1 migration scripts, R2 wiring, Access admin | `09`, `03`, `05` updates | Production stack running on Pages/Workers/D1/R2 with parity |
| M7 Launch Readiness | Week 11 | Ops dashboards, moderation SOP, incident runbooks, content QA | `10`, `11` finalized | Soft launch ready with monitored ingestion and moderation workflows |

## Feature Additions Beyond Request (Planned)
1. Breaking weather banner on `Today` and `Kentucky` when severe alerts exist.
2. County watch shortcut in drawer for one-tap local updates.
3. Source transparency badges (`source`, `published`, `updated`, `region_scope`).
4. Feed health diagnostics in admin (`last_checked_at`, `error streak`, `last success`).
5. Optional post-launch: web push alerts for weather emergencies and major KY headlines.

## Testing and Acceptance Scenarios
1. Ingest dedupe: same article from repeated feed polls does not create duplicate item IDs.
2. KY county tagging: known county and city mentions map correctly to counties.
3. National isolation: `scope=national` results never pollute county-only views.
4. Pagination correctness: cursor-based paging returns stable, non-overlapping sequences.
5. Search correctness: quotes, `AND`, `OR`, and `-exclude` return expected article sets.
6. Weather refresh: forecast and alerts refresh on schedule and honor county filter.
7. Lost submission validation: missing email, invalid image type, or oversized files are rejected.
8. Moderation gate: pending posts are never visible on public endpoints.
9. PWA offline: previously opened Reader pages and last fetched Today list work offline.
10. PWA update: app displays refresh prompt and safely reloads to new service worker.
11. Admin security: `/admin` endpoints blocked without Cloudflare Access identity.
12. Rate-limit behavior: repeated submission attempts from same IP are throttled.
13. Cloud migration parity: Worker endpoints match local API response shapes for core routes.
14. Cross-device smoke: iOS Safari, Android Chrome, desktop Chrome baseline flows pass.

## Rollout and Operations Plan
1. Environments: `local`, `staging`, `production` with separate D1 DBs and R2 buckets.
2. Deployment flow: Pages preview on PR-equivalent branch, promote to production after smoke suite.
3. Scheduled jobs: feed ingest every 15 minutes; weather refresh every 10 minutes.
4. Monitoring metrics: ingest success rate, median API latency, county-tag coverage, moderation queue age.
5. Alerts: notify on ingest failure streaks, zero-new-items anomalies, weather job failures.
6. Manual fallback: admin endpoint to trigger on-demand ingest/weather refresh.
7. Content governance: moderation SLA target under 2 hours daytime for lost-and-found queue.

## Explicit Assumptions and Defaults
1. Existing markdown docs shown in IDE are not present in this workspace and will be recreated under `docs/`.
2. Curated feed sourcing is editorially controlled by admins; no public source submission in MVP.
3. Weather source remains NOAA/NWS only in MVP to avoid paid API dependencies.
4. Lost-and-found submission is anonymous (no user account), with required email and pre-moderation.
5. Admin authentication is handled exclusively by Cloudflare Access, not in-app login.
6. Kentucky remains the only county-level geography in MVP; national has its own non-county lane.
7. Local Node services remain until Worker/D1 parity is verified; then local stack is kept for dev fallback.
8. Initial launch is US English only and mobile-first.
9. Performance targets: LCP under 2.5s on mobile 4G, API P95 under 600ms for list endpoints.
10. Compliance baseline includes Terms, Privacy, moderation policy, and takedown contact pages before launch.

```

# PROJECT_CONTEXT.md

```md
# Project Context

This project now uses the canonical documentation set in `docs/`.

- Overview: `docs/00_PROJECT_OVERVIEW.md`
- Product requirements: `docs/01_PRODUCT_REQUIREMENTS.md`
- Information architecture: `docs/02_INFORMATION_ARCHITECTURE.md`
- Data model: `docs/03_DATA_MODEL.md`
- Roadmap: `docs/10_ROADMAP.md`

```

# react-blog-main\.gitignore

```
# See https://help.github.com/articles/ignoring-files/ for more about ignoring files.

# dependencies
/node_modules
/.pnp
.pnp.js

# testing
/coverage

# production
/build

# misc
.DS_Store
.env.local
.env.development.local
.env.test.local
.env.production.local

npm-debug.log*
yarn-debug.log*
yarn-error.log*
.eslintcache
 

```

# react-blog-main\package.json

```json
{
  "name": "pwa",
  "version": "0.1.0",
  "private": true,
  "homepage": "/pwa/",
  "dependencies": {
    "@material-ui/core": "^4.11.2",
    "@material-ui/icons": "^4.11.2",
    "@material-ui/lab": "^4.0.0-alpha.57",
    "@testing-library/jest-dom": "^5.11.8",
    "@testing-library/react": "^11.2.3",
    "@testing-library/user-event": "^12.6.0",
    "moment": "^2.29.1",
    "react": "^17.0.1",
    "react-dom": "^17.0.1",
    "react-redux": "^7.2.2",
    "react-router-dom": "^5.2.0",
    "react-scripts": "4.0.1",
    "redux": "^4.0.5",
    "web-vitals": "^0.2.4",
    "workbox-background-sync": "^5.1.4",
    "workbox-broadcast-update": "^5.1.4",
    "workbox-cacheable-response": "^5.1.4",
    "workbox-core": "^5.1.4",
    "workbox-expiration": "^5.1.4",
    "workbox-google-analytics": "^5.1.4",
    "workbox-navigation-preload": "^5.1.4",
    "workbox-precaching": "^5.1.4",
    "workbox-range-requests": "^5.1.4",
    "workbox-routing": "^5.1.4",
    "workbox-strategies": "^5.1.4",
    "workbox-streams": "^5.1.4"
  },
  "scripts": {
    "start": "set HOST=intranet&& react-scripts start",
    "build": "GENERATE_SOURCEMAP=false react-scripts build",
    "winBuild": "set \"GENERATE_SOURCEMAP=false\" && react-scripts build",
    "test": "react-scripts test",
    "eject": "react-scripts eject"
  },
  "eslintConfig": {
    "extends": [
      "react-app",
      "react-app/jest"
    ]
  },
  "browserslist": {
    "production": [
      ">0.2%",
      "not dead",
      "not op_mini all"
    ],
    "development": [
      "last 1 chrome version",
      "last 1 firefox version",
      "last 1 safari version"
    ]
  }
}

```

# react-blog-main\preview_images\tech_news_en_desktop.gif

This is a binary file of the type: Image

# react-blog-main\preview_images\tech_news_en_mobile.gif

This is a binary file of the type: Image

# react-blog-main\public\favicon.ico

This is a binary file of the type: Binary

# react-blog-main\public\img\preview.PNG

This is a binary file of the type: Image

# react-blog-main\public\index.html

```html
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="utf-8" />
  <link rel="icon" href="%PUBLIC_URL%/favicon.ico" />
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
  <meta name="theme-color" content="#000000" />
  <meta name="description" content="Informohuni mbi zhvillimet me te fundit ne fushen e Internetit, Teknologjise dhe Informatikes." />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="Lajme shqip nga Teknologjia dhe Informatika" />
  <meta property="og:description"
    content="Informohuni mbi zhvillimet me te fundit ne fushen e Internetit, Teknologjise dhe Informatikes." />
  <meta property="og:url" content="https://edisonneza.github.io/blog/" />
  <meta property="og:site_name" content="Tech News - Blog by Edison Neza" />
  <meta property="article:publisher" content="https://www.edisonneza.github.io" />
  <meta property="article:author" content="https://www.edisonneza.github.io" />
  <meta property="og:image" content="%PUBLIC_URL%/img/preview.PNG" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:description"
    content="Informohuni mbi zhvillimet me te fundit ne fushen e Internetit, Teknologjise dhe Informatikes." />
  <meta name="twitter:title" content="Lajme shqip nga Teknologjia dhe Informatika - Tech News" />
  <meta name="twitter:site" content="@edisonneza_blog" />
  <meta name="twitter:image" content="%PUBLIC_URL%/img/preview.PNG" />
  <meta name="twitter:creator" content="@edisonneza" />
  <link rel="apple-touch-icon" href="%PUBLIC_URL%/logo192.png" />
  <!--
      manifest.json provides metadata used when your web app is installed on a
      user's mobile device or desktop. See https://developers.google.com/web/fundamentals/web-app-manifest/
    -->
  <link rel="manifest" href="%PUBLIC_URL%/manifest.json" />
  <!--
      Notice the use of %PUBLIC_URL% in the tags above.
      It will be replaced with the URL of the `public` folder during the build.
      Only files inside the `public` folder can be referenced from the HTML.

      Unlike "/favicon.ico" or "favicon.ico", "%PUBLIC_URL%/favicon.ico" will
      work correctly both with client-side routing and a non-root public URL.
      Learn how to configure a non-root public URL by running `npm run build`.
    -->
  <title>Tech News</title>
</head>

<body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="root"></div>
  <!--
      This HTML file is a template.
      If you open it directly in the browser, you will see an empty page.

      You can add webfonts, meta tags, or analytics to this file.
      The build step will place the bundled scripts into the <body> tag.

      To begin the development, run `npm start` or `yarn start`.
      To create a production bundle, use `npm run build` or `yarn build`.
    -->
</body>

</html>
```

# react-blog-main\public\logo192.png

This is a binary file of the type: Image

# react-blog-main\public\logo512.png

This is a binary file of the type: Image

# react-blog-main\public\manifest.json

```json
{
  "short_name": "Tech News",
  "name": "Lajme rreth teknologjisë",
  "icons": [
    {
      "src": "favicon.ico",
      "sizes": "64x64 32x32 24x24 16x16",
      "type": "image/x-icon"
    },
    {
      "src": "logo192.png",
      "type": "image/png",
      "sizes": "192x192"
    },
    {
      "src": "logo512.png",
      "type": "image/png",
      "sizes": "512x512"
    }
  ],
  "start_url": "/pwa/",
  "display": "standalone",
  "theme_color": "#3367D6",
  "background_color": "#ffffff",
  "scope": "/pwa/",
  "shortcuts": [
    {
      "name": "Kërko lajme",
      "short_name": "Kërko",
      "description": "Hyni ne pamjen e kerkimit te informacioneve",
      "url": "/pwa/search",
      "icons": [{ "src": "/pwa/logo192.png", "sizes": "192x192" }]
    },
    {
      "name": "Shiko postimet e ruajtura",
      "short_name": "Të ruajtura",
      "description": "Shiko postimet qe keni ruajtur gjate leximit",
      "url": "/pwa/saved",
      "icons": [{ "src": "/pwa/logo192.png", "sizes": "192x192" }]
    }
  ]
}

```

# react-blog-main\public\robots.txt

```txt
# https://www.robotstxt.org/robotstxt.html
User-agent: *
Disallow:

```

# react-blog-main\README.md

```md
# PWA Blog template using ReactJs and Material UI

This is a template PWA - Progresive Web Application that uses ReactJs and Material UI. <br/>
App works offline by saving responses in localStorage. <br/>
Currently I've done the development in a subfolder ('/pwa/'). To run in the root folder just remove the ("homepage": "/pwa/",) in the package.json file. (Also remove the "set HOST=intranet&& " from scripts->start property in package.json)

<b>Store is now managed by React-Redux.</b>
<del>Store is managed using React's Context API. </del><br/>
<i>Switch to <b>"react-context"</b> branch to see the React-Contex version</i><br/>

<i>(Posts are being retrieved from a wordpress site using the WordPress REST API)</i>

Steps to install and start playing with the project:

1. git clone https://github.com/edisonneza/react-blog.git
2. npm i
3. npm run start

To generate build files (by removing the source map files) 

* npm run winBuild
<br/>
or <i>(if LINUX)</i>

* npm run build

See GIFs below on desktop and mobile devices:

![desktop version](preview_images/tech_news_en_desktop.gif)

![mobile version](preview_images/tech_news_en_mobile.gif)


```

# react-blog-main\src\App.css

```css
@media (prefers-reduced-motion: no-preference) {
  
}



```

# react-blog-main\src\App.js

```js
import React from "react";
import "./App.css";
import { BrowserRouter as Router, Switch, Route } from "react-router-dom";

import HomePage from "./pages/home-page";
import SettingsPage from "./pages/settings-page";
import LabelBottomNavigation from "./components/bottom-navigation";
import AppHeader from "./components/app-header";
import SearchPage from "./pages/search-page";
import SavedPage from "./pages/saved-page";
import PostPage from "./pages/post-page";
import FavoritesPage from "./pages/favorites-page";
import { Container, Box } from "@material-ui/core";
import CssBaseline from "@material-ui/core/CssBaseline";
import { isMobile } from "./utils/functions";
import { Provider } from "react-redux";
import store from "./redux/store/store";
import Theme from "./components/theme";

function App() {
  return (
    <Provider store={store}>
      <Theme>
        <CssBaseline />
        <Router basename={process.env.PUBLIC_URL}>
          <div className="App">
            <AppHeader />

            <Container>
              <Box>
                <Switch>
                  <Route exact path="/">
                    <HomePage />
                  </Route>
                  <Route path="/search">
                    <SearchPage />
                  </Route>
                  <Route path="/favorites">
                    <FavoritesPage />
                  </Route>
                  <Route path="/saved">
                    <SavedPage />
                  </Route>
                  <Route path="/settings">
                    <SettingsPage />
                  </Route>
                  <Route path="/post">
                    <PostPage />
                  </Route>
                </Switch>
              </Box>
            </Container>
            <br />
            <br />
            <br />
            <br />
            {isMobile() && <LabelBottomNavigation />}
          </div>
        </Router>
      </Theme>
    </Provider>
  );
}

export default App;

```

# react-blog-main\src\App.test.js

```js
import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders learn react link', () => {
  render(<App />);
  const linkElement = screen.getByText(/learn react/i);
  expect(linkElement).toBeInTheDocument();
});

```

# react-blog-main\src\components\app-header.js

```js
import React, { useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import AppBar from "@material-ui/core/AppBar";
import Toolbar from "@material-ui/core/Toolbar";
import Typography from "@material-ui/core/Typography";
import IconButton from '@material-ui/core/IconButton';
import MenuIcon from '@material-ui/icons/Menu';
import SideBarMenu from './sidebar-menu-component';
import { isMobile } from '../utils/functions';
import { useSelector } from "react-redux";

const useStyles = makeStyles((theme) => ({
  root: {
    flexGrow: 1,
    // backgroundColor: theme.palette.background.paper
  },
  toolbar: {
    minHeight: "44px",
  },
  title: {
    flexGrow: 1,
    textAlign: "center",
  },
  // appBar: {
  //   backgroundColor: theme.palette.grey[800]
  // }
}));

export default function AppHeader() {
  const classes = useStyles();
  const title = useSelector(state => state.title);
  const mobile = isMobile();

  const [open, setOpen] = useState(false);

  return (
    <div className={classes.root}>
      <AppBar position="static" color="default">
        <Toolbar className={classes.toolbar}>
          {!mobile && (<IconButton
            edge="start"
            className={classes.menuButton}
            color="inherit"
            aria-label="menu"
            onClick={() => setOpen(true)}
          >
            <MenuIcon />
          </IconButton>) }
          <Typography variant="h6" className={classes.title}>
            {/* Lajmet e përmbledhura teknologjike */}
            {title}
          </Typography>
        </Toolbar>
      </AppBar>

      {!mobile && <SideBarMenu open={open} handleOpen={() => setOpen(!open)}/>}
    </div>
  );
}

```

# react-blog-main\src\components\bottom-navigation.js

```js
import React, { useEffect } from "react";
import { makeStyles } from "@material-ui/core/styles";
import BottomNavigation from "@material-ui/core/BottomNavigation";
import BottomNavigationAction from "@material-ui/core/BottomNavigationAction";
import SearchIcon from "@material-ui/icons/Search";
import HomeIcon from "@material-ui/icons/Home";
import FavoriteIcon from "@material-ui/icons/Favorite";
import BookmarksIcon from "@material-ui/icons/Bookmarks";
import SettingsIcon from "@material-ui/icons/Settings";
import { useHistory } from "react-router-dom";
import Constants from "../constants/constants";
import { useDispatch } from "react-redux";
import { setTitle } from "../redux/actions/actions";

const useStyles = makeStyles({
  root: {
    width: "100%",
    position: "fixed",
    left: "0px",
    right: "0px",
    bottom: 0,
  },
});

export default function LabelBottomNavigation() {
  const classes = useStyles();
  let history = useHistory();
  const [value, setValue] = React.useState(history.location.pathname);

  const dispatch = useDispatch();
  const handleTitle = (title) => dispatch(setTitle(title));

  const setTitleByRoute = (value) => {
    switch (value) {
      case "/":
        handleTitle(Constants.appName);
        break;
      case "/search":
        handleTitle("Kërkoni");
        break;
      case "/favorites":
        handleTitle("Preferencat");
        break;
      case "/saved":
        handleTitle("Postimet e ruajtura");
        break;
      case "/settings":
        handleTitle("Cilësimet");
        break;
      default:
        handleTitle(Constants.appName);
        break;
    }
  };

  useEffect(() => {
    setTitleByRoute(value);
  }, [value]);

  const handleChange = (event, newValue) => {
    setValue(newValue);
    setTitleByRoute(newValue);
    history.push(newValue);
  };

  return (
    <BottomNavigation
      value={value}
      onChange={handleChange}
      className={classes.root}
    >
      <BottomNavigationAction label="Kryefaqja" value="/" icon={<HomeIcon />} />
      <BottomNavigationAction
        label="Kërko"
        value="/search"
        icon={<SearchIcon />}
      />
      <BottomNavigationAction
        label="Preferencat"
        value="/favorites"
        icon={<BookmarksIcon />}
      />
      <BottomNavigationAction
        label="Ruajtur"
        value="/saved"
        icon={<FavoriteIcon />}
      />
      <BottomNavigationAction
        label="Cilësimet"
        value="/settings"
        icon={<SettingsIcon />}
      />
    </BottomNavigation>
  );
}

```

# react-blog-main\src\components\favorites\chips-component.js

```js
import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import Chip from "@material-ui/core/Chip";
import DoneIcon from "@material-ui/icons/Done";
import SiteService from "../../services/siteService";

const useStyles = makeStyles((theme) => ({
  root: {
    display: "flex",
    justifyContent: "center",
    flexWrap: "wrap",
    "& > *": {
      margin: theme.spacing(0.5),
    },
  },
}));

const siteService = new SiteService();

export default function ChipsComponent() {
  const classes = useStyles();
  const [tags, setTags] = React.useState([]);

  const handleClick = (value) => {
    siteService.saveTags(value).then(data => setTags(data));
  };

  React.useEffect(() => {
    siteService.getTags().then(data => setTags(data));
  }, []);

  return (
    <div className={classes.root}>
      {tags.map((item, index) => {
        return (
          <Chip
            key={index}
            label={item.value}
            onClick={() => handleClick(item.value)}
            onDelete={() => handleClick(item.value)}
            deleteIcon={!item.active ? <DoneIcon /> : null}
            variant="outlined"
            color={item.active ? "primary" : "default"}
          />
        );
      })}
    </div>
  );
}

```

# react-blog-main\src\components\featured-post-component.js

```js
import React from "react";
import PropTypes from "prop-types";
import { makeStyles } from "@material-ui/core/styles";
import Paper from "@material-ui/core/Paper";
import Typography from "@material-ui/core/Typography";
import Grid from "@material-ui/core/Grid";
import Button from "@material-ui/core/Button";
import { useDispatch } from "react-redux";
import { setPost } from "../redux/actions/actions";

const useStyles = makeStyles((theme) => ({
  mainFeaturedPost: {
    position: "relative",
    backgroundColor: theme.palette.grey[800],
    color: theme.palette.common.white,
    marginBottom: theme.spacing(4),
    backgroundImage: "url(https://source.unsplash.com/random)",
    backgroundSize: "cover",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
  },
  overlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,.3)",
  },
  mainFeaturedPostContent: {
    position: "relative",
    padding: theme.spacing(3),
    [theme.breakpoints.up("md")]: {
      padding: theme.spacing(6),
      paddingRight: 0,
    },
  },
}));

export default function FeaturedPost(props) {
  const dispatch = useDispatch();

  const handlePost = (post) => dispatch(setPost(post));

  const classes = useStyles();
  const { post } = props;

  return (
    <Paper
      className={classes.mainFeaturedPost}
      style={{ backgroundImage: `url(${post.image})` }}
    >
      {/* Increase the priority of the hero background image */}
      {
        <img
          style={{ display: "none" }}
          src={post.image}
          alt={post.imageText}
        />
      }
      <div className={classes.overlay} />
      <Grid container>
        <Grid item md={6}>
          <div className={classes.mainFeaturedPostContent}>
            <Typography
              component="h1"
              variant="h3"
              color="inherit"
              gutterBottom
            >
              {post.title}
            </Typography>
            <Typography
              variant="h5"
              color="inherit"
              paragraph
              dangerouslySetInnerHTML={{
                __html:
                  post.description.split(" ").splice(0, 15).join(" ") + "...",
              }}
            >
              {/* {post.description.split(' ').splice(0, 10).join(' ')}... */}
            </Typography>
            <Button
              size="small"
              color="primary"
              // onClick={() => history.push(location)}
              onClick={() => handlePost(post)}
            >
              Vazhdo leximin...
            </Button>
          </div>
        </Grid>
      </Grid>
    </Paper>
  );
}

FeaturedPost.propTypes = {
  post: PropTypes.object,
};

```

# react-blog-main\src\components\home\posts-component.js

```js
import React from "react";
import PropTypes from "prop-types";
import Grid from "@material-ui/core/Grid";
import SinglePost from './single-post-component';

export default function Posts(props) {
  const { posts, showDelete, handleDelete } = props;

  return (
    <Grid container spacing={3}>
      {posts.map((post) => (
        <SinglePost key={post.title} post={post} showDelete={showDelete} handleDelete={handleDelete} />
      ))}
    </Grid>
  );
}

Posts.propTypes = {
  posts: PropTypes.array,
  showDelete: PropTypes.bool,
  handleDelete: PropTypes.func
};

```

# react-blog-main\src\components\home\sections-component.js

```js
import React, { useState } from "react";
import PropTypes from "prop-types";
import { makeStyles } from "@material-ui/core/styles";
import Toolbar from "@material-ui/core/Toolbar";
import Tab from "@material-ui/core/Tab";
import Tabs from "@material-ui/core/Tabs";
import { useDispatch, useSelector } from "react-redux";
import { setTabSelected } from "../../redux/actions/actions";

const useStyles = makeStyles((theme) => ({
  toolbar: {
    borderBottom: `1px solid ${theme.palette.divider}`,
  },
  toolbarTitle: {
    flex: 1,
  },
  toolbarSecondary: {
    justifyContent: "space-between",
    overflowX: "auto",
  },
  toolbarLink: {
    padding: theme.spacing(1),
    flexShrink: 0,
    // borderRadius: '50%',
    // width: 100,
    // height: 100,
    // padding: 10,
    // marginRight: 5,
    // border: '1px solid red'
  },
}));

function a11yProps(index) {
  return {
    id: `scrollable-auto-tab-${index}`,
    "aria-controls": `scrollable-auto-tabpanel-${index}`,
  };
}

export default function SectionsHeader(props) {
  const classes = useStyles();
  const tabSelected = useSelector(state => state.tabSelected);
  const dispatch = useDispatch();

  const { sections } = props;
  const [value, setValue] = useState({
    id: tabSelected.index,
    value: sections[tabSelected.index].title,
  });

  const handleTabChange = (event, val) => {
    dispatch(setTabSelected({index: val, value: event.target.innerText}));
    setValue({ id: val, value: event.target.innerText });
  };

  return (
    <React.Fragment>
      {/* <Toolbar className={classes.toolbar}>
        <Button size="small">Subscribe</Button>
        <Typography
          component="h2"
          variant="h5"
          color="inherit"
          align="center"
          noWrap
          className={classes.toolbarTitle}
        >
          {title}
        </Typography>
        <IconButton>
          <SearchIcon />
        </IconButton>
        <Button variant="outlined" size="small">
          Sign up
        </Button>
      </Toolbar> */}
      <Toolbar
        component="nav"
        variant="dense"
        className={classes.toolbarSecondary}
      >
        <Tabs
          value={value.id}
          onChange={handleTabChange}
          indicatorColor="primary"
          textColor="primary"
          variant="scrollable"
          scrollButtons="auto"
          aria-label="scrollable auto tabs example"
        >
          {sections.map((section, index) => (
            <Tab key={index} label={section.title} {...a11yProps(index)} />
          ))}
        </Tabs>
      </Toolbar>
    </React.Fragment>
  );
}

SectionsHeader.propTypes = {
  sections: PropTypes.array,
  title: PropTypes.string,
};

```

# react-blog-main\src\components\home\single-post-component.js

```js
import React, { useState } from "react";
import PropTypes from "prop-types";
import Typography from "@material-ui/core/Typography";
import Grid from "@material-ui/core/Grid";
import Card from "@material-ui/core/Card";
import CardActionArea from "@material-ui/core/CardActionArea";
import CardContent from "@material-ui/core/CardContent";
import CardMedia from "@material-ui/core/CardMedia";
import CardActions from "@material-ui/core/CardActions";
import IconButton from "@material-ui/core/IconButton";
import ShareIcon from "@material-ui/icons/Share";
import FavoriteIcon from "@material-ui/icons/Favorite";
import { DateFromNow, ShareAPI } from "../../utils/functions";
import { Delete } from "@material-ui/icons";
import { GetValue, SaveValue } from "../../services/storageService";
import { Button, Dialog, DialogActions, DialogTitle } from "@material-ui/core";
import { SavePost } from "../../services/storageService";
import { makeStyles } from "@material-ui/core/styles";
import SnackbarNotify from "../snackbar-notify-component";
import { useDispatch } from "react-redux";
import { setPost } from "../../redux/actions/actions";

const useStyles = makeStyles({
  cardContent: {
    padding: "10px 8px 0 10px",
  },
});

export default function SinglePost(props) {
  const classes = useStyles();
  const { post, showDelete, handleDelete } = props;
  const [openDialog, setOpenDialog] = useState(false);
  const [openSnackbarNotify, setOpenSnackbarNotify] = useState(false);
  const dispatch = useDispatch();
  const handlePost = (post) => dispatch(setPost(post));
  
  const handleDeletePost = () => {
    const posts = GetValue("savedPost");
    if (posts) {
      const otherPosts = posts.filter(
        (item) => item.originalLink !== post.originalLink
      );
      SaveValue("savedPost", otherPosts);
      handleDelete(post); //to refresh the post list in parent component
    }
  };

  const handleSavePost = () => {
    SavePost(post);
    setOpenSnackbarNotify(true);
  };

  const handleShare = () => {
    const title = post.title;
    const text = `Une po lexoj nga webi Tech News. Lexo postimin ne linkun origjinal: ${post.title}`;
    const url = post.originalLink;

    ShareAPI(title, text, url);
  };

  return (
    <>
      {openSnackbarNotify && (
        <SnackbarNotify message="Posti u ruaj me sukses!" />
      )}
      <Grid item xs={12} sm={6} md={4}>
        <Card>
          <CardActionArea>
            {/* <CardActionArea component="a" href="#"> */}
            {/* <Card className={classes.card}>
          <div className={classes.cardDetails}>
            <CardContent>
              <Typography component="h2" variant="h5">
                {post.title}
              </Typography>
              <Typography variant="subtitle1" color="textSecondary">
                {post.date}
              </Typography>
              <Typography variant="subtitle1" paragraph>
                {post.description}
              </Typography>
              <Typography variant="subtitle1" color="primary">
                Continue reading...
              </Typography>
            </CardContent>
          </div>
          <Hidden xsDown>
            <CardMedia className={classes.cardMedia} image={post.image} title={post.imageTitle} />
          </Hidden>
        </Card> */}
            <CardMedia
              component="img"
              alt={post.imageTitle}
              height="140"
              image={post.image}
              title={post.imageTitle}
            />
            <CardContent
              onClick={() => handlePost(post)}
              className={classes.cardContent}
            >
              <Typography gutterBottom variant="h5" component="h2">
                {post.title}
              </Typography>
              <Typography
                variant="body2"
                color="textSecondary"
                component="p"
                dangerouslySetInnerHTML={{
                  __html:
                    post.shortDesc.split(" ").splice(0, 20).join(" ") + "...",
                }}
              ></Typography>
            </CardContent>
          </CardActionArea>
          <CardActions>
            <Grid container justify="space-between">
              <Grid item>
                <i style={{ marginRight: 20 }}>{DateFromNow(post.date)}</i>

                {/* <IconButton
                color="primary"
                aria-label="WhatsApp"
                component="span"
                size="small"
              >
                <WhatsAppIcon />
              </IconButton> */}

                {/* <Button
                size="small"
                color="primary"
                // onClick={() => history.push({ pathname: post.link, state: { post } })}
                onClick={() => handlePost(post)}
              >
                Vazhdo leximin...
              </Button> */}
              </Grid>

              <Grid item>
                <IconButton
                  color="primary"
                  aria-label="Ruaj"
                  component="span"
                  onClick={handleSavePost}
                  size="small"
                  style={{ marginRight: 10 }}
                >
                  <FavoriteIcon />
                </IconButton>
                <IconButton
                  color="primary"
                  aria-label="Share"
                  component="span"
                  size="small"
                  onClick={handleShare}
                >
                  <ShareIcon />
                </IconButton>

                {showDelete && (
                  <IconButton
                    color="secondary"
                    aria-label="Fshi postimin"
                    component="span"
                    size="small"
                    onClick={() => setOpenDialog(true)}
                    style={{ marginLeft: 10 }}
                  >
                    <Delete />
                  </IconButton>
                )}
              </Grid>
            </Grid>
          </CardActions>
        </Card>
      </Grid>

      <Dialog
        open={openDialog}
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">
          {"Jeni të sigurtë për fshirjen e këtij postimi?"}
        </DialogTitle>
        <DialogActions>
          <Button color="primary" onClick={() => setOpenDialog(false)}>
            Jo
          </Button>
          <Button onClick={handleDeletePost} color="primary" autoFocus>
            Po
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

SinglePost.propTypes = {
  post: PropTypes.object,
  showDelete: PropTypes.bool,
  handleDelete: PropTypes.func,
};

```

# react-blog-main\src\components\post\dialog-fullscreen-component.js

```js
import React, { useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import IconButton from "@material-ui/core/IconButton";
import Dialog from "@material-ui/core/Dialog";
import Divider from "@material-ui/core/Divider";
import CloseIcon from "@material-ui/icons/Close";
import { Slide } from "@material-ui/core";
import FeaturedPost from "./post-component";
import { Container, Fab } from "@material-ui/core";
import FavoriteBorderIcon from "@material-ui/icons/FavoriteBorder";
import ShareIcon from "@material-ui/icons/Share";
import { SavePost } from "../../services/storageService";
import { ShareAPI } from "../../utils/functions";
import SnackbarNotify from '../snackbar-notify-component';
// import { useHistory } from 'react-router-dom';

const useStyles = makeStyles((theme) => ({
  appBar: {
    position: "relative",
  },
  title: {
    marginLeft: theme.spacing(2),
    flex: 1,
  },
  fab: {
    position: "fixed",
    bottom: theme.spacing(2),
    right: theme.spacing(2),
  },
  button: {
    margin: theme.spacing(1),
  },
}));

const Transition = React.forwardRef(function Transition(props, ref) {
  return <Slide direction="up" ref={ref} {...props} />;
});

export default function FullScreenPostDialog(props) {
  const classes = useStyles();
  const [openSnackbarNotify, setOpenSnackbarNotify] = useState(false);

  const handleClose = () => {
    props.handlePost(null);
  };

  const handleSavePost = () => {
    SavePost(props.post);
    setOpenSnackbarNotify(true);
    setTimeout(() => {
      setOpenSnackbarNotify(false);
    }, 2000);
  }

  const handleShare = () => {
    const title = props.post.title;
    const text = `Une po lexoj nga webi Tech News. Lexo postimin ne linkun origjinal: ${props.post.title}`
    const url = props.post.originalLink;

    ShareAPI(title, text, url);
  }

  let open = !!props.post;

  return (
    <div>
      {openSnackbarNotify && (
        <SnackbarNotify message="Posti u ruaj me sukses!" />
      )}
      {/* <Button variant="outlined" color="primary" onClick={handleClickOpen}>
        Open full-screen dialog
      </Button> */}
      <Dialog
        fullScreen
        open={open}
        onClose={handleClose}
        TransitionComponent={Transition}
      >
        {/* <AppBar className={classes.appBar}>
          <Toolbar className={classes.title}>
            <IconButton
              edge="start"
              color="inherit"
              onClick={handleClose}
              aria-label="close"
            >
              <CloseIcon />
            </IconButton>
            <Typography variant="h6" className={classes.title}>
              Sound
            </Typography>
            <Button autoFocus color="inherit" onClick={handleClose}>
              save
            </Button>
          </Toolbar>
        </AppBar> */}
        <br />
        <br />
        <Container>
          {props.post && <FeaturedPost post={props.post} />}
          <Divider />

          <IconButton
            className={classes.buttons}
            aria-label="ruaj"
            component="span"
            onClick={handleSavePost}
            // size="large"
          >
            <FavoriteBorderIcon fontSize="large"/>
          </IconButton>
          <IconButton
            className={classes.buttons}
            aria-label="Share"
            component="span"
            // size="large"
            onClick={handleShare}
          >
            <ShareIcon fontSize="large"/>
          </IconButton>


          <Divider />
          <br /> <br />
          <Fab
            aria-label={"test"}
            className={classes.fab}
            color="primary"
            onClick={handleClose}
            // size="small"
          >
            <CloseIcon />
          </Fab>
        </Container>
      </Dialog>
    </div>
  );
}

```

# react-blog-main\src\components\post\post-component.css

```css
.description .wp-block-image {
    text-align: center;
}

.description img{
    max-width: 100%;
}
```

# react-blog-main\src\components\post\post-component.js

```js
import React from "react";
import PropTypes from "prop-types";
import { makeStyles } from "@material-ui/core/styles";
import Paper from "@material-ui/core/Paper";
import Typography from "@material-ui/core/Typography";
import Grid from "@material-ui/core/Grid";
import Button from "@material-ui/core/Button";
import Divider from "@material-ui/core/Divider";
import "./post-component.css";
import { ToDateTime } from '../../utils/functions';

const useStyles = makeStyles((theme) => ({
  mainFeaturedPost: {
    position: "relative",
    backgroundColor: theme.palette.grey[800],
    color: theme.palette.common.white,
    marginBottom: theme.spacing(4),
    // backgroundImage: "url(https://source.unsplash.com/random)",
    backgroundSize: "cover",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
    minHeight: 320
  },
  overlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,.3)",
  },
  mainFeaturedPostContent: {
    margin: 40,
    position: "relative",
    padding: theme.spacing(3),
    [theme.breakpoints.up("md")]: {
      padding: theme.spacing(10),
      paddingRight: 0,
    },
  },
  buttonsDiv: {
    margin: 5,
  },
  buttons: {
    marginRight: 15,
  },
}));

export default function FeaturedPost(props) {
  const classes = useStyles();
  const { post } = props;

  return (
    <main>
      <Paper
        className={classes.mainFeaturedPost}
        style={{ backgroundImage: `url(${post.image})` }}
      >
      </Paper>
      <Divider />
      <Grid item xs={12} md={9}>
        <Typography variant="h5" gutterBottom style={{ padding: 10 }}>
          {post.title}
        </Typography>
        <Divider />
        <Typography variant="subtitle1" className={classes.buttonsDiv}>
          <Button
            variant="outlined"
            size="small"
            className={classes.buttons}
            href={post.originalLink}
            target="_blank"
          >
            Linku origjinal
          </Button>
          {/* <IconButton
            className={classes.buttons}
            aria-label="Facebook"
            component="span"
            size="small"
          >
            <FacebookIcon />
          </IconButton>
          <IconButton
            className={classes.buttons}
            aria-label="WhatsApp"
            component="span"
            size="small"
          >
            <WhatsAppIcon /> 
          </IconButton> */}
            <i style={{fontSize: 12}}>{ToDateTime(post.date)}</i>
        </Typography>
        <Divider />
        <Typography
          variant="body1"
          className={"description"}
          dangerouslySetInnerHTML={{ __html: post.description }}
        ></Typography>
      </Grid>
    </main>
  );
}

FeaturedPost.propTypes = {
  post: PropTypes.object,
};

```

# react-blog-main\src\components\settings\preferences-component.js

```js
import React from "react";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Switch from "@material-ui/core/Switch";
import { makeStyles } from "@material-ui/core/styles";
import Grid from "@material-ui/core/Grid";
import { useSelector, useDispatch } from "react-redux";
import { setDarkTheme } from "../../redux/actions/actions";
const useStyles = makeStyles((theme) => ({
  root: {
    display: "flex",
    flexWrap: "wrap",
    marginTop: 15,
  },
  formControl: {
    minWidth: 120,
  },
}));

export default function SettingsForm() {
  const classes = useStyles();
  const darkTheme = useSelector((state) => state.darkTheme);
  const dispatch = useDispatch();

  const handleChange = (event) => {
    if (event.target.name === "darkTheme")
      dispatch(setDarkTheme(event.target.checked));
    // setState({ ...state, [event.target.name]: event.target.checked });
  };

  return (
    <form className={classes.root} noValidate autoComplete="off">
      <Grid container>
        <Grid item xs={12}>
          <Grid container justify="space-between">
            <Grid item>
              <FormControlLabel
                control={<p></p>}
                label="Modaliteti errësirë (Dark Mode)"
                labelPlacement="start"
              />
            </Grid>
            <Grid item>
              <FormControlLabel
                control={
                  <Switch
                    checked={darkTheme}
                    onChange={handleChange}
                    name="darkTheme"
                  />
                }
                label=""
                labelPlacement="start"
              />
            </Grid>
          </Grid>{" "}
          {/*end container*/}
        </Grid>
      </Grid>
    </form>
  );
}

```

# react-blog-main\src\components\sidebar-menu-component.js

```js
import React, { useEffect } from "react";
import { makeStyles } from "@material-ui/core/styles";
import Drawer from "@material-ui/core/Drawer";
import CssBaseline from "@material-ui/core/CssBaseline";
import List from "@material-ui/core/List";
import Divider from "@material-ui/core/Divider";
import IconButton from "@material-ui/core/IconButton";
import ChevronLeftIcon from "@material-ui/icons/ChevronLeft";
import ListItem from "@material-ui/core/ListItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import SearchIcon from "@material-ui/icons/Search";
import HomeIcon from "@material-ui/icons/Home";
import FavoriteIcon from "@material-ui/icons/Favorite";
import BookmarksIcon from "@material-ui/icons/Bookmarks";
import SettingsIcon from "@material-ui/icons/Settings";
import { useHistory } from "react-router-dom";
import Constants from "../constants/constants";
import { useDispatch } from "react-redux";
import { setTitle } from "../redux/actions/actions";

const drawerWidth = 240;

const useStyles = makeStyles((theme) => ({
  root: {
    display: "flex",
  },
  appBar: {
    transition: theme.transitions.create(["margin", "width"], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.leavingScreen,
    }),
  },
  appBarShift: {
    width: `calc(100% - ${drawerWidth}px)`,
    marginLeft: drawerWidth,
    transition: theme.transitions.create(["margin", "width"], {
      easing: theme.transitions.easing.easeOut,
      duration: theme.transitions.duration.enteringScreen,
    }),
  },
  menuButton: {
    marginRight: theme.spacing(2),
  },
  hide: {
    display: "none",
  },
  drawer: {
    width: drawerWidth,
    flexShrink: 0,
  },
  drawerPaper: {
    width: drawerWidth,
  },
  drawerHeader: {
    display: "flex",
    alignItems: "center",
    padding: theme.spacing(0, 1),
    // necessary for content to be below app bar
    ...theme.mixins.toolbar,
    justifyContent: "space-between",
    minHeight: "44px !important",
  },
}));

export default function SideBarMenu({ open, handleOpen }) {
  const classes = useStyles();
  //   const theme = useTheme();
  const history = useHistory();
  const [value, setValue] = React.useState(history.location.pathname);
  const dispatch = useDispatch();

  const handleTitle = (title) => dispatch(setTitle(title));

  const setTitleByRoute = (value) => {
    switch (value) {
      case "/":
        handleTitle(Constants.appName);
        break;
      case "/search":
        handleTitle("Kërkoni");
        break;
      case "/favorites":
        handleTitle("Preferencat");
        break;
      case "/saved":
        handleTitle("Postimet e ruajtura");
        break;
      case "/settings":
        handleTitle("Cilësimet");
        break;
      default:
        handleTitle(Constants.appName);
        break;
    }
  };

  const handleChange = (newValue) => {
    history.push(newValue);
    setValue(newValue);
    // setTitleByRoute(newValue);
  };

  const isSelected = (route) => {
    return history.location.pathname === route;
  };

  useEffect(() => {
    setTitleByRoute(value);
  }, [value]);

  return (
    <div className={classes.root}>
      <CssBaseline />
      <Drawer
        className={classes.drawer}
        variant="persistent"
        anchor="left"
        open={open}
        classes={{
          paper: classes.drawerPaper,
        }}
      >
        <div className={classes.drawerHeader}>
          <span style={{ margin: "0 auto" }}>{Constants.appName}</span>
          <IconButton onClick={handleOpen}>
            <ChevronLeftIcon />
          </IconButton>
        </div>
        <Divider />
        <List>
          <ListItem
            button
            key={1}
            selected={isSelected("/")}
            onClick={() => handleChange("/")}
          >
            <ListItemIcon>
              <HomeIcon />
            </ListItemIcon>
            <ListItemText primary="Kryefaqja" />
          </ListItem>
          <ListItem
            button
            key={2}
            selected={isSelected("/search")}
            onClick={() => handleChange("/search")}
          >
            <ListItemIcon>
              <SearchIcon />
            </ListItemIcon>
            <ListItemText primary="Kërkoni" />
          </ListItem>
          <ListItem
            button
            key={3}
            selected={isSelected("/favorites")}
            onClick={() => handleChange("/favorites")}
          >
            <ListItemIcon>
              <BookmarksIcon />
            </ListItemIcon>
            <ListItemText primary="Preferencat" />
          </ListItem>
          <ListItem
            button
            key={4}
            selected={isSelected("/saved")}
            onClick={() => handleChange("/saved")}
          >
            <ListItemIcon>
              <FavoriteIcon />
            </ListItemIcon>
            <ListItemText primary="Ruajtur" />
          </ListItem>
          <ListItem
            button
            key={5}
            selected={isSelected("/settings")}
            onClick={() => handleChange("/settings")}
          >
            <ListItemIcon>
              <SettingsIcon />
            </ListItemIcon>
            <ListItemText primary="Cilësimet" />
          </ListItem>
        </List>
      </Drawer>
    </div>
  );
}

```

# react-blog-main\src\components\skeletons-component.js

```js
import React from "react";
import PropTypes from "prop-types";
import { makeStyles } from "@material-ui/core/styles";
import Skeleton from "@material-ui/lab/Skeleton";
import Grid from "@material-ui/core/Grid";

const useStyles = makeStyles({
  root: {},
  media: {
    height: 190,
  },
});

export default function Skeletons({showFeaturedSkeleton}) {
  const classes = useStyles();


  return (
    <>
    {showFeaturedSkeleton &&
    <>
      <Skeleton animation="wave" variant="rect" className={classes.media} />
      <Skeleton animation="wave" height={10} style={{ marginBottom: 6 }} />
      <Skeleton animation="wave" height={10} style={{ marginBottom: 6 }} />
      </>
    }
      <br /> <br />
      <Grid container spacing={3}>
        {Array.from(new Array(3)).map((item, index) => (
          <Grid item key={index} xs={12} md={4}>
            <Skeleton
              animation="wave"
              variant="rect"
              className={classes.media}
            />
            <Skeleton
              animation="wave"
              height={10}
              style={{ marginBottom: 6 }}
            />
            <Skeleton
              animation="wave"
              height={10}
              style={{ marginBottom: 6 }}
            />
            <Skeleton
              animation="wave"
              height={10}
              style={{ marginBottom: 6 }}
            />
            <Skeleton
              animation="wave"
              height={10}
              style={{ marginBottom: 6 }}
            />
          </Grid>
        ))}
      </Grid>
    </>
  );
}

Skeletons.protoTypes = {
  showFeaturedSkeleton: PropTypes.bool
}

```

# react-blog-main\src\components\snackbar-no-internet-component.js

```js
import React, { useState } from 'react';
import { Snackbar, IconButton} from "@material-ui/core";
import CloseIcon from "@material-ui/icons/Close";

export default function SnackbarNoInternet() {
    const [open, setOpen ] = useState(!navigator.onLine);

    setTimeout(() => {
        setOpen(false);
    }, 10 * 1000);

    return (<Snackbar
              anchorOrigin={{ vertical: "top", horizontal: "center" }}
              open={open}
              message="Momentalisht nuk jeni online. Do ju shfaqen postimet e shikuara se fundmi."
              action={
                  <IconButton
                    aria-label="close"
                    color="inherit"
                    onClick={() => setOpen(!open)}
                  >
                    <CloseIcon />
                  </IconButton>
              }
            />)
}
```

# react-blog-main\src\components\snackbar-notify-component.js

```js
import React from 'react';
import Snackbar from '@material-ui/core/Snackbar';
import IconButton from '@material-ui/core/IconButton';
import CloseIcon from '@material-ui/icons/Close';

export default function SnackbarNotify({message}) {
  const [open, setOpen] = React.useState(!!message.length);

  const handleClose = (event, reason) => {
    if (reason === 'clickaway') {
      return;
    }

    setOpen(false);
  };

  return (
    <div>
      <Snackbar
        anchorOrigin={{
          vertical: 'top',
          horizontal: 'center',
        }}
        open={open}
        autoHideDuration={2000}
        onClose={handleClose}
        message={message}
        action={
          <React.Fragment>
            <IconButton size="small" aria-label="close" color="inherit" onClick={handleClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </React.Fragment>
        }
      />
    </div>
  );
}

```

# react-blog-main\src\components\theme.js

```js
import React from "react";
import {
  ThemeProvider,
  unstable_createMuiStrictModeTheme as createMuiTheme,
} from "@material-ui/core/styles";
import FullScreenPostDialog from "./post/dialog-fullscreen-component";
import {
  orange,
  lightBlue,
  deepPurple,
  deepOrange,
} from "@material-ui/core/colors";
import { useDispatch, shallowEqual, useSelector } from "react-redux";
import { setPost } from "../redux/actions/actions";

export default function Theme({ children }) {
  const dispatch = useDispatch();
  const post = useSelector((state) => state.post, shallowEqual);
  const darkTheme = useSelector((state) => state.darkTheme);

  const palletType = darkTheme ? "dark" : "light";
  const mainPrimaryColor = darkTheme ? orange[500] : lightBlue[500];
  const mainSecondaryColor = darkTheme ? deepOrange[900] : deepPurple[500];

  const Theme = {
    palette: {
      type: palletType,
      primary: {
        main: mainPrimaryColor,
      },
      secondary: {
        main: mainSecondaryColor,
      },
    },
  };
  const theme = createMuiTheme(Theme);

  const handlePost = (post) => dispatch(setPost(post));

  return (
    <ThemeProvider theme={theme}>
      <FullScreenPostDialog post={post} handlePost={handlePost} />
      {children}
    </ThemeProvider>
  );
}

```

# react-blog-main\src\constants\constants.js

```js
const Constants = {
    appName: 'Tech News',
    appVersion: 'v.1.0',
    localStoragePrefix: 'tech_new_app_'
}

export default Constants;
```

# react-blog-main\src\customHooks\custom-hooks.js

```js
import React from "react";

export function usePrevious(value) {
  const ref = React.useRef();
  React.useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

// use async operation with automatic abortion on unmount
export function useAsync(asyncFn, onSuccess) {
  React.useEffect(() => {
    let isMounted = true;
    asyncFn().then(data => {
      if (isMounted) onSuccess(data);
    });
    return () => {
      isMounted = false;
    };
  }, [asyncFn, onSuccess]);
}

```

# react-blog-main\src\index.css

```css
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
    'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

code {
  font-family: source-code-pro, Menlo, Monaco, Consolas, 'Courier New',
    monospace;
}

```

# react-blog-main\src\index.js

```js
import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './App';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';
import reportWebVitals from './reportWebVitals';

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://cra.link/PWA
// serviceWorkerRegistration.unregister();
serviceWorkerRegistration.register();

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();

```

# react-blog-main\src\logo.svg

This is a file of the type: SVG Image

# react-blog-main\src\pages\favorites-page.js

```js
import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import ChipsComponent from "../components/favorites/chips-component";

const useStyles = makeStyles({
  root: {},
});

export default function FavoritesPage() {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      <h4>Zgjidhni perferencat në bazë të të cilave do ju shfaqen postimet</h4>
      <ChipsComponent />
    </div>
  );
}

```

# react-blog-main\src\pages\home-page.js

```js
import React, { useState, useEffect } from "react";
import { makeStyles } from "@material-ui/core/styles";
import SectionsHeader from "../components/home/sections-component";
import FeaturedPost from "../components/featured-post-component";
import Posts from "../components/home/posts-component";
import SiteService from "../services/siteService";
import { IconButton } from "@material-ui/core";
import Skeletons from "../components/skeletons-component";
import { usePrevious } from "../customHooks/custom-hooks";
import Snackbar from "@material-ui/core/Snackbar";
import CloseIcon from "@material-ui/icons/Close";
import SnackbarNoInternet from "../components/snackbar-no-internet-component";
import { useDispatch, useSelector } from "react-redux";
import { setPosts } from "../redux/actions/actions";

const useStyles = makeStyles((theme) => ({
  root: {},
  close: {
    padding: theme.spacing(0.5),
  },
}));

const service = new SiteService();

export default function HomePage() {
  const classes = useStyles();
  const posts = useSelector((state) => state.posts);
  const tabSelected = useSelector((state) => state.tabSelected);
  const dispatch = useDispatch();

  const [isLoading, setIsLoading] = useState(true);
  const [errors, setErrors] = useState("");

  const tabSelectedPrev = usePrevious(tabSelected);
  useEffect(() => {
    // if (!categories)
    //   service.getCategories().then((data) => handleCategories(data));
    // if (!tags) service.getTags().then((data) => handleTags(data));
    if (!posts || (tabSelectedPrev && tabSelectedPrev !== tabSelected)) {
      setIsLoading(true);
      let searchVal = tabSelected.index > 0 ? tabSelected.value : "";
      service
        .getPosts(searchVal)
        .then((data) => {
          dispatch(setPosts(data));
          setIsLoading(false);
        })
        .catch((error) => {
          setErrors(error.errorMessage);
        });
    } else setIsLoading(false);
  }, [tabSelected.index]);

  const sections = [
    { title: "Të gjitha", url: "#" },
    { title: "Teknologji", url: "#" },
    { title: "Apple", url: "#" },
    { title: "Microsoft", url: "#" },
    { title: "Android", url: "#" },
    { title: "Samsung", url: "#" },
    { title: "Shkence", url: "#" },
    { title: "Programim", url: "#" },
    { title: "Design", url: "#" },
    { title: "Nasa", url: "#" },
    { title: "Covid", url: "#" },
  ];

  return (
    <div className={classes.root}>
      {/* <h4>Faqja kryesore</h4> */}
      <SectionsHeader sections={sections} title="test" />
      <main>
        <SnackbarNoInternet />
        {!isLoading && posts.length > 0 ? (
          <>
            <FeaturedPost post={posts[0]} />
            <Posts posts={posts.filter((item, index) => index !== 0)} />{" "}
            {/* get all but not first item (because is used in FeaturedPost) */}
          </>
        ) : (
          <>
            <Snackbar
              anchorOrigin={{ vertical: "top", horizontal: "center" }}
              open={!!errors}
              message={errors}
              key={"topcenter"}
              action={
                <IconButton
                  aria-label="close"
                  color="inherit"
                  className={classes.close}
                  onClick={() => setErrors("")}
                >
                  <CloseIcon />
                </IconButton>
              }
            />
            <Skeletons showFeaturedSkeleton />
          </>
        )}
        {/* <FullScreenPostDialog /> */}
      </main>
    </div>
  );
}

```

# react-blog-main\src\pages\post-page.js

```js
import React, { useEffect } from "react";
import { makeStyles } from "@material-ui/core/styles";
import Post from "../components/post/post-component";
import CircularProgress from "@material-ui/core/CircularProgress";
import { useLocation } from 'react-router-dom';

const useStyles = makeStyles({
  root: {
    marginTop: 15,
  },
});

export default function PostPage() {
  const classes = useStyles();
  const location = useLocation();

  // const [post, setPost] = useState(location.state.post);

  useEffect(() => {
    
  }, []);

  return (
    <div className={classes.root}>
      {location.state.post ? <Post post={location.state.post} /> : <center><CircularProgress /></center>}
    </div>
  );
}

```

# react-blog-main\src\pages\saved-page.js

```js
import React, { useEffect, useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import { TextField, Grid, Divider } from "@material-ui/core";
import Posts from "../components/home/posts-component";
import { GetValue } from "../services/storageService";

const useStyles = makeStyles({
  root: {},
  gridContainer: {
    display: "flex",
    alignItems: "center",
  },
});

export default function SavedPage() {
  const classes = useStyles();

  const [searchVal, setSearchVal] = useState("");
  const [posts, setPosts] = useState();

  useEffect(() => {
    if (searchVal.length > 2) {
      const posts = GetValue("savedPost");
      if (posts) {
        const postsFound = posts.filter(
          (item) =>
            item.title.toLowerCase().indexOf(searchVal.toLowerCase()) > -1
        );
        setPosts(postsFound);
      }
    } else {
      setPosts(GetValue("savedPost"));
    }
  }, [searchVal]);

  const handleChange = (ev) => {
    setSearchVal(ev.target.value);
  };

  const handleDelete = (post) => {
    setPosts(GetValue("savedPost"));
  };

  return (
    <div className={classes.root}>
      {/* <h4>Kërko</h4> */}
      <Grid container className={classes.gridContainer}>
        <Grid item xs={false} md={3}></Grid>
        <Grid item xs={12} md={6}>
          <TextField
            id="standard-full-width"
            label="Kërkoni një postim të ruajtur"
            style={{ margin: 8 }}
            value={searchVal}
            // placeholder="Shkruani një fjalë ose një grup fjalësh"
            helperText="Me shumë se 2 karaktere"
            fullWidth
            margin="normal"
            InputLabelProps={{
              shrink: true,
            }}
            onChange={handleChange}
            autoComplete="off"
          />
        </Grid>
      </Grid>
      <Divider />
      <br />
      <Grid container>
        {posts && posts.length ? (
          <Posts posts={posts} showDelete handleDelete={handleDelete} />
        ) : (
          <h3 style={{width: "100%", textAlign: "center"}}>
            Asnjë postim nuk u gjend.
          </h3>
        )}
      </Grid>
    </div>
  );
}

```

# react-blog-main\src\pages\search-page.js

```js
import React, { useEffect, useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import { TextField, Grid, Divider, Snackbar, IconButton } from "@material-ui/core";
import CloseIcon from "@material-ui/icons/Close";
import Skeletons from "../components/skeletons-component";
import Posts from "../components/home/posts-component";
import SiteService from "../services/siteService";
import { useDispatch, useSelector } from "react-redux";
import { setSearchPosts } from "../redux/actions/actions";

const useStyles = makeStyles({
  root: {},
  gridContainer: {
    display: "flex",
    alignItems: "center",
  },
});

const service = new SiteService();

export default function SearchPage() {
  const classes = useStyles();
  const searchPosts = useSelector(state => state.searchPosts);
  const dispatch = useDispatch();

  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState("");
  const [searchVal, setSearchVal] = useState(searchPosts.searchValue);

  useEffect(() => {
    const delaySearch = setTimeout(() => {
      //wait 1 sec until user stop typing
      if (searchVal.length > 2) {
        setIsLoading(true);
        service
          .getPosts(searchVal, 15)
          .then((data) => {
            dispatch(setSearchPosts({ searchValue: searchVal, posts: data }));
            setIsLoading(false);
          })
          .catch((error) => {
            setErrors(error.errorMessage);
          });
      } else {
            dispatch(setSearchPosts({ searchValue: "", posts: [] }));
      }
    }, 1000);

    return () => clearTimeout(delaySearch);
  }, [searchVal]);

  const handleChange = (ev) => {
    setSearchVal(ev.target.value);
  };

  return (
    <div className={classes.root}>
      {/* <h4>Kërko</h4> */}
      <Grid container className={classes.gridContainer}>
        <Grid item xs={false} md={3}></Grid>
        <Grid item xs={12} md={6}>
          <TextField
            id="standard-full-width"
            label="Kërkoni një postim"
            style={{ margin: 8 }}
            value={searchVal}
            // placeholder="Shkruani një fjalë ose një grup fjalësh"
            helperText="Me shumë se 2 karaktere"
            fullWidth
            margin="normal"
            InputLabelProps={{
              shrink: true,
            }}
            onChange={handleChange}
            autoComplete="off"
          />
        </Grid>
      </Grid>
      <Divider />
      <br />
      <Grid container>
        {!isLoading && searchPosts.posts ? (
          <>
            <Posts posts={searchPosts.posts} />
          </>
        ) : (
          isLoading && <Skeletons />
        )}
      </Grid>

      <Snackbar
              anchorOrigin={{ vertical: "top", horizontal: "center" }}
              open={!!errors}
              message={errors}
              key={"topcenter"}
              action={
                  <IconButton
                    aria-label="close"
                    color="inherit"
                    className={classes.close}
                    onClick={() => setErrors('')}
                  >
                    <CloseIcon />
                  </IconButton>
              }
            />
    </div>
  );
}

```

# react-blog-main\src\pages\settings-page.js

```js
import { Typography, Link } from "@material-ui/core";
import React from "react";
import SettingsForm from "../components/settings/preferences-component";
import Constants from "../constants/constants";

export default function SettingsPage() {
  return (
    <>
      <SettingsForm />
      <br/>
      <br/>
      <Typography variant="caption" display="block" gutterBottom>
        <center>
          <Link href="https://github.com/edisonneza" target="_blank">&copy;  Edison Neza </Link>
          <br/><span>{Constants.appVersion}</span>
          </center>
      </Typography>
    </>
  );
}

```

# react-blog-main\src\redux\actions\actions.js

```js
export const SET_TITLE = "SET_TITLE";
export const SET_DARK_THEME = "SET_DARK_THEME";
export const SET_POSTS = "SET_POSTS";
export const SET_POST = "SET_POST";
export const SET_CATEGORIES = "SET_CATEGORIES";
export const SET_TAGS = "SET_TAGS";
export const SET_TAB_SELECTED = "SET_TAB_SELECTED";
export const SET_SEARCH_POSTS = "SET_SEARCH_POSTS";

export function setTitle(title) {
  return { type: SET_TITLE, title: title };
}

export function setDarkTheme(darkTheme) {
  return { type: SET_DARK_THEME, darkTheme };
}

export function setPosts(posts) {
  return { type: SET_POSTS, posts };
}

export function setPost(post) {
  return { type: SET_POST, post };
}

export function setCategories(categories) {
  return { type: SET_CATEGORIES, categories };
}

export function setTags(tags) {
  return { type: SET_TAGS, tags };
}

export function setTabSelected(tabSelected) {
  return { type: SET_TAB_SELECTED, tabSelected };
}

export function setSearchPosts(searchPosts) {
  return { type: SET_SEARCH_POSTS, searchPosts };
}

```

# react-blog-main\src\redux\reducers\reducers.js

```js
import {
  SET_TITLE,
  SET_DARK_THEME,
  SET_POST,
  SET_POSTS,
  SET_CATEGORIES,
  SET_TAGS,
  SET_SEARCH_POSTS,
  SET_TAB_SELECTED,
} from "../actions/actions";
import Constants from "../../constants/constants";
import { GetValue, SaveValue } from "../../services/storageService";

const initialState = {
  title: Constants.appName,
  darkTheme: GetValue("darkTheme"),
  posts: null,
  categories: null,
  tags: null,
  post: null,
  tabSelected: { index: 0, value: "" },
  searchPosts: {
    searchValue: "",
    posts: null,
  },
};

function rootReducer(state = initialState, action) {
  switch (action.type) {
    case SET_TITLE:
      return {
        ...state,
        title: action.title,
      };
    case SET_DARK_THEME:
      SaveValue("darkTheme", action.darkTheme);
      return {
        ...state,
        darkTheme: action.darkTheme,
      };
    case SET_POST:
      return {
        ...state,
        post: action.post,
      };
    case SET_POSTS:
      return {
        ...state,
        posts: action.posts,
      };
    case SET_CATEGORIES:
      return {
        ...state,
        categories: action.categories,
      };

    case SET_TAGS:
      return {
        ...state,
        tags: action.tags,
      };

    case SET_SEARCH_POSTS:
      return {
        ...state,
        searchPosts: {
          searchValue: action.searchPosts.searchValue,
          posts: action.searchPosts.posts,
        },
      };

    case SET_TAB_SELECTED:
      return {
        ...state,
        tabSelected: {
          index: action.tabSelected.index,
          value: action.tabSelected.value,
        },
      };
    default:
      return state;
  }
}

export default rootReducer;

```

# react-blog-main\src\redux\store\store.js

```js
import { createStore } from 'redux';
import rootReducer from '../reducers/reducers';

export default createStore (
    rootReducer,
    undefined,
    window.__REDUX_DEVTOOLS_EXTENSION__ && window.__REDUX_DEVTOOLS_EXTENSION__()
)
```

# react-blog-main\src\reportWebVitals.js

```js
const reportWebVitals = (onPerfEntry) => {
  if (onPerfEntry && onPerfEntry instanceof Function) {
    import('web-vitals').then(({ getCLS, getFID, getFCP, getLCP, getTTFB }) => {
      getCLS(onPerfEntry);
      getFID(onPerfEntry);
      getFCP(onPerfEntry);
      getLCP(onPerfEntry);
      getTTFB(onPerfEntry);
    });
  }
};

export default reportWebVitals;

```

# react-blog-main\src\service-worker.js

```js
/* eslint-disable no-restricted-globals */

// This service worker can be customized!
// See https://developers.google.com/web/tools/workbox/modules
// for the list of available Workbox modules, or add any other
// code you'd like.
// You can also remove this file if you'd prefer not to use a
// service worker, and the Workbox build step will be skipped.

import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate } from 'workbox-strategies';

clientsClaim();

// Precache all of the assets generated by your build process.
// Their URLs are injected into the manifest variable below.
// This variable must be present somewhere in your service worker file,
// even if you decide not to use precaching. See https://cra.link/PWA
precacheAndRoute(self.__WB_MANIFEST);

// Set up App Shell-style routing, so that all navigation requests
// are fulfilled with your index.html shell. Learn more at
// https://developers.google.com/web/fundamentals/architecture/app-shell
const fileExtensionRegexp = new RegExp('/[^/?]+\\.[^/]+$');
registerRoute(
  // Return false to exempt requests from being fulfilled by index.html.
  ({ request, url }) => {
    // If this isn't a navigation, skip.
    if (request.mode !== 'navigate') {
      return false;
    } // If this is a URL that starts with /_, skip.

    if (url.pathname.startsWith('/_')) {
      return false;
    } // If this looks like a URL for a resource, because it contains // a file extension, skip.

    if (url.pathname.match(fileExtensionRegexp)) {
      return false;
    } // Return true to signal that we want to use the handler.

    return true;
  },
  createHandlerBoundToURL(process.env.PUBLIC_URL + '/index.html')
);

// An example runtime caching route for requests that aren't handled by the
// precache, in this case same-origin .png requests like those from in public/
registerRoute(
  // Add in any other file extensions or routing criteria as needed.
  ({ url }) => url.origin === self.location.origin && url.pathname.endsWith('.png'), // Customize this strategy as needed, e.g., by changing to CacheFirst.
  new StaleWhileRevalidate({
    cacheName: 'images',
    plugins: [
      // Ensure that once this runtime cache reaches a maximum size the
      // least-recently used images are removed.
      new ExpirationPlugin({ maxEntries: 50 }),
    ],
  })
);

// This allows the web app to trigger skipWaiting via
// registration.waiting.postMessage({type: 'SKIP_WAITING'})
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Any other custom service worker logic can go here.

```

# react-blog-main\src\services\configService.js

```js
export default class Configurations {
    constructor() {
      this.configUrl =
        "https://raw.githubusercontent.com/edisonneza/edisonneza.github.io/configs/publicConfigs/config.json";
    }
  
    getAll() {
      return fetch(this.configUrl)
        .then((resp) => resp.json())
        .then((data) => data)
        .catch((err) => err);
    }
  }
  
```

# react-blog-main\src\services\siteService.js

```js
import { SaveValue, GetValue } from "./storageService";

export default class SiteService {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    if (!baseUrl) this.baseUrl = "https://shop.shpresa.al/wp-json/wp/v2";
  }

  getPosts(searchQuery, perPage=10) {
    if (!navigator.onLine) {
      return new Promise((resolve, reject) => {
        if (GetValue("posts")) resolve(GetValue("posts"));
        else
          reject({
            errorMessage:
              "Momentalisht nuk keni lidhje interneti dhe nuk keni shikuar asnje post deri tani. Provoni perseri pasi te jeni ne linje.",
          });
      });
    } else {
      return fetch(
        `${this.baseUrl}/posts?_embed=wp:featuredmedia&per_page=${perPage}&search=${searchQuery}`
      )
        .then((resp) => resp.json())
        .then((data) => {
          const posts = data.map((data) => {
            // console.log(data)
            return {
              title: data.title.rendered,
              date: data.date,
              shortDesc: data.excerpt.rendered,
              description: data.content.rendered,
              image: data._embedded["wp:featuredmedia"]["0"].source_url, // "https://source.unsplash.com/random",
              imageText: "Image Text",
              link: "/post",
              originalLink: data.link,
            };
          });
          SaveValue("posts", posts);
          return posts;
        })
        .catch((err) => err);
    }
  }

  getCategories() {
    if (!navigator.onLine)
      return new Promise((resolve, reject) => resolve(GetValue("categories")));
    else {
      return fetch(this.baseUrl + "/categories")
        .then((resp) => resp.json())
        .then((data) => {
          SaveValue("categories", data);
          return data;
        })
        .catch((err) => err);
    }
  }

  getTags() {
    if (!navigator.onLine)
      return new Promise((resolve, reject) => resolve(GetValue("tags")));
    else {
      // return fetch(this.baseUrl + "/tags")
      //   .then((resp) => resp.json())
      //   .then((data) => {
      //     SaveValue("tags", data);
      //     return data;
      //   })
      //   .catch((err) => err);
      return new Promise((resolve, reject) => {
        const localStorageTags = GetValue('tags');
        if(!localStorageTags || !localStorageTags.length){
          const initialTags = [
            { value: "Apple", active: false },
            { value: "Technology", active: false },
            { value: "Microsoft", active: false },
            { value: "Android", active: false },
            { value: "iOS", active: false },
            { value: "Shkence", active: false },
            { value: "Samsung", active: false },
            { value: "iPhone", active: false },
            { value: "OnePlus", active: false },
            { value: "Nokia", active: false },
            { value: "Programming", active: false },
            { value: "Website", active: false },
            { value: "Web App", active: false },
            { value: ".NET 5", active: false },
            { value: "ASP.NET", active: false },
            { value: "C#", active: false },
            { value: "Java", active: false },
            { value: "Javascript", active: false },
            { value: "Typescript", active: false },
            { value: "PHP", active: false },
            { value: "React", active: false },
            { value: "Angular", active: false },
            { value: "Covid", active: false },
          ];
          SaveValue('tags', initialTags);
        }

        return resolve(GetValue('tags'));
      });
    }
  }

  saveTags(value) { //to save all
    return new Promise((resolve, reject) => {
      const tags = GetValue('tags');
      const newTags = tags.map((item) => {
        return item.value !== value ? item : { value, active: !item.active };
      });
      SaveValue('tags', newTags);
      resolve(GetValue('tags'));
    });
  }

  getPostByHref(href) {
    return fetch(href)
      .then((resp) => resp.json())
      .then((data) => {
        const post = {
          title: data.title.rendered,
          date: data.date,
          description: data.content.rendered,
          image: data._embedded["wp:featuredmedia"]["0"].source_url, // "https://source.unsplash.com/random",
          imageText: "Image Text",
          link: "/post",
        };
        return post;
      })
      .catch((err) => err);
  }
}

```

# react-blog-main\src\services\storageService.js

```js
import Constants from '../constants/constants';

export function SaveValue(name, values) {
  localStorage.setItem(Constants.localStoragePrefix + name, JSON.stringify(values));
}

export function GetValue(name) {
  return JSON.parse(localStorage.getItem(Constants.localStoragePrefix + name));
}

export function SavePost(post){
  let savedPost = GetValue('savedPost');
  if(savedPost){
    const postExist = savedPost.filter(item => item.originalLink === post.originalLink).length > 0;
    if(!postExist)
      SaveValue('savedPost', [...savedPost, {...post}]);
  }else{
    SaveValue('savedPost', [{...post}])
  }
}

// export function GetValues() {
//   let items = [];
//   for (var key in localStorage) {
//     if (key.indexOf("StorageName") === 0) {
//       const item = JSON.parse(localStorage[key]);
//       const arr = { key: key, ...item };
//       items.push(JSON.stringify(arr));
//     }
//   }

//   return items;
// }

export function DeleteValue(name) {
  localStorage.removeItem(Constants.localStoragePrefix + name);
}

```

# react-blog-main\src\serviceWorkerRegistration.js

```js
// This optional code is used to register a service worker.
// register() is not called by default.

// This lets the app load faster on subsequent visits in production, and gives
// it offline capabilities. However, it also means that developers (and users)
// will only see deployed updates on subsequent visits to a page, after all the
// existing tabs open on the page have been closed, since previously cached
// resources are updated in the background.

// To learn more about the benefits of this model and instructions on how to
// opt-in, read https://cra.link/PWA

const isLocalhost = Boolean(
  window.location.hostname === 'localhost' ||
    // [::1] is the IPv6 localhost address.
    window.location.hostname === '[::1]' ||
    // 127.0.0.0/8 are considered localhost for IPv4.
    window.location.hostname.match(/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/)
);

export function register(config) {
  if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
    // The URL constructor is available in all browsers that support SW.
    const publicUrl = new URL(process.env.PUBLIC_URL, window.location.href);
    if (publicUrl.origin !== window.location.origin) {
      // Our service worker won't work if PUBLIC_URL is on a different origin
      // from what our page is served on. This might happen if a CDN is used to
      // serve assets; see https://github.com/facebook/create-react-app/issues/2374
      return;
    }

    window.addEventListener('load', () => {
      const swUrl = `${process.env.PUBLIC_URL}/service-worker.js`;

      if (isLocalhost) {
        // This is running on localhost. Let's check if a service worker still exists or not.
        checkValidServiceWorker(swUrl, config);

        // Add some additional logging to localhost, pointing developers to the
        // service worker/PWA documentation.
        navigator.serviceWorker.ready.then(() => {
          console.log(
            'This web app is being served cache-first by a service ' +
              'worker. To learn more, visit https://cra.link/PWA'
          );
        });
      } else {
        // Is not localhost. Just register service worker
        registerValidSW(swUrl, config);
      }
    });
  }
}

function registerValidSW(swUrl, config) {
  navigator.serviceWorker
    .register(swUrl)
    .then((registration) => {
      registration.onupdatefound = () => {
        const installingWorker = registration.installing;
        if (installingWorker == null) {
          return;
        }
        installingWorker.onstatechange = () => {
          if (installingWorker.state === 'installed') {
            if (navigator.serviceWorker.controller) {
              // At this point, the updated precached content has been fetched,
              // but the previous service worker will still serve the older
              // content until all client tabs are closed.
              console.log(
                'New content is available and will be used when all ' +
                  'tabs for this page are closed. See https://cra.link/PWA.'
              );

              // Execute callback
              if (config && config.onUpdate) {
                config.onUpdate(registration);
              }
            } else {
              // At this point, everything has been precached.
              // It's the perfect time to display a
              // "Content is cached for offline use." message.
              console.log('Content is cached for offline use.');

              // Execute callback
              if (config && config.onSuccess) {
                config.onSuccess(registration);
              }
            }
          }
        };
      };
    })
    .catch((error) => {
      console.error('Error during service worker registration:', error);
    });
}

function checkValidServiceWorker(swUrl, config) {
  // Check if the service worker can be found. If it can't reload the page.
  fetch(swUrl, {
    headers: { 'Service-Worker': 'script' },
  })
    .then((response) => {
      // Ensure service worker exists, and that we really are getting a JS file.
      const contentType = response.headers.get('content-type');
      if (
        response.status === 404 ||
        (contentType != null && contentType.indexOf('javascript') === -1)
      ) {
        // No service worker found. Probably a different app. Reload the page.
        navigator.serviceWorker.ready.then((registration) => {
          registration.unregister().then(() => {
            window.location.reload();
          });
        });
      } else {
        // Service worker found. Proceed as normal.
        registerValidSW(swUrl, config);
      }
    })
    .catch(() => {
      console.log('No internet connection found. App is running in offline mode.');
    });
}

export function unregister() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => {
        registration.unregister();
      })
      .catch((error) => {
        console.error(error.message);
      });
  }
}

```

# react-blog-main\src\setupTests.js

```js
// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

```

# react-blog-main\src\utils\functions.js

```js
import moment from 'moment';
import 'moment/locale/sq';


export function ToDateTime(value){
    return moment(value).locale('sq').format('DD/MM/YYYY hh:mm:ss');
}

export function DateFromNow(value){
    return moment(value).locale('sq').fromNow();
}

export async function ShareAPI(title, text, url){
    if (navigator.share === undefined) {
        console.log('Error: Unsupported feature: navigator.share');
        return;
      }
  
    //   const text = `Une po lexoj nga faqja Tech News. Lexo postimin nga linkun origjinal: ${props.post.title}`
  
      try {
        await navigator.share({title, text, url});
        console.log('Successfully sent share');
      } catch (error) {
        console.log('Error sharing: ' + error);
      }
}

export function isMobile(){
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}
```

# scripts\reset-db.mjs

```mjs
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(process.cwd());
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "dev.sqlite");

fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new Database(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  url TEXT NOT NULL,
  state_code TEXT NOT NULL DEFAULT 'KY',
  default_county TEXT,
  region_scope TEXT NOT NULL DEFAULT 'ky',
  enabled INTEGER NOT NULL DEFAULT 1,
  etag TEXT,
  last_modified TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  guid TEXT,
  author TEXT,
  region_scope TEXT NOT NULL DEFAULT 'ky',
  published_at TEXT,
  summary TEXT,
  content TEXT,
  image_url TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  hash TEXT,
  article_checked_at TEXT,
  article_fetch_status TEXT,
  article_text_excerpt TEXT
);

CREATE TABLE IF NOT EXISTS feed_items (
  feed_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (feed_id, item_id),
  FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

-- Location tags: state_code always present; county = '' means "state-level only"
CREATE TABLE IF NOT EXISTS item_locations (
  item_id TEXT NOT NULL,
  state_code TEXT NOT NULL,
  county TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (item_id, state_code, county),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_published_at ON items(published_at);
CREATE INDEX IF NOT EXISTS idx_items_url ON items(url);
CREATE INDEX IF NOT EXISTS idx_items_region_scope ON items(region_scope);
CREATE INDEX IF NOT EXISTS idx_item_locations_state ON item_locations(state_code);
CREATE INDEX IF NOT EXISTS idx_item_locations_county ON item_locations(state_code, county);
CREATE INDEX IF NOT EXISTS idx_feed_items_feed ON feed_items(feed_id);
CREATE INDEX IF NOT EXISTS idx_feeds_region_scope ON feeds(region_scope);

CREATE TABLE IF NOT EXISTS fetch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT,
  at TEXT NOT NULL,
  error TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weather_forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_code TEXT NOT NULL,
  county TEXT NOT NULL,
  forecast_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_weather_forecasts_county ON weather_forecasts(state_code, county, fetched_at);

CREATE TABLE IF NOT EXISTS weather_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id TEXT NOT NULL,
  state_code TEXT NOT NULL,
  county TEXT NOT NULL,
  severity TEXT,
  event TEXT,
  headline TEXT,
  starts_at TEXT,
  ends_at TEXT,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_weather_alerts_state_county ON weather_alerts(state_code, county, fetched_at);
CREATE INDEX IF NOT EXISTS idx_weather_alerts_alert_id ON weather_alerts(alert_id);

CREATE TABLE IF NOT EXISTS lost_found_posts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('lost', 'found')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  county TEXT NOT NULL,
  state_code TEXT NOT NULL DEFAULT 'KY',
  contact_email_encrypted TEXT NOT NULL,
  show_contact INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  rejected_at TEXT,
  expires_at TEXT NOT NULL,
  moderation_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_lost_found_posts_status ON lost_found_posts(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_lost_found_posts_county ON lost_found_posts(state_code, county, status);

CREATE TABLE IF NOT EXISTS lost_found_images (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES lost_found_posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lost_found_images_post_id ON lost_found_images(post_id);

CREATE TABLE IF NOT EXISTS lost_found_reports (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  reporter_ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES lost_found_posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lost_found_reports_post_id ON lost_found_reports(post_id, created_at);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at);
`);

db.close();
console.log("✅ DB reset:", dbPath);

```

# scripts\seed-feeds.mjs

```mjs
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(process.cwd());
const seedPath = path.join(root, "feeds.seed.json");
const dbPath = path.join(root, "data", "dev.sqlite");

if (!fs.existsSync(seedPath)) {
  console.error("Missing feeds.seed.json");
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error("Missing DB. Run: npm run db:reset");
  process.exit(1);
}

const feeds = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
const db = new Database(dbPath);
const feedCols = db.prepare("PRAGMA table_info(feeds)").all().map((r) => r.name);
if (!feedCols.includes("default_county")) {
  db.prepare("ALTER TABLE feeds ADD COLUMN default_county TEXT").run();
}

const upsert = db.prepare(`
INSERT INTO feeds (id, name, category, url, state_code, default_county, region_scope, enabled)
VALUES (
  @id,
  @name,
  @category,
  @url,
  COALESCE(@state_code, 'KY'),
  @default_county,
  COALESCE(@region_scope, 'ky'),
  COALESCE(@enabled, 1)
)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  category=excluded.category,
  url=excluded.url,
  state_code=excluded.state_code,
  default_county=excluded.default_county,
  region_scope=excluded.region_scope,
  enabled=excluded.enabled
`);

const seedIds = feeds.map((f) => f.id);
const deleteStale =
  seedIds.length > 0
    ? db.prepare(
        `DELETE FROM feeds WHERE id NOT IN (${seedIds.map((_, idx) => `@id${idx}`).join(", ")})`
      )
    : db.prepare("DELETE FROM feeds");

const tx = db.transaction((rows) => {
  for (const f of rows) upsert.run({ default_county: null, ...f });
  const staleParams = {};
  seedIds.forEach((id, idx) => {
    staleParams[`id${idx}`] = id;
  });
  deleteStale.run(staleParams);
});

tx(feeds);
db.close();

console.log("✅ Seeded feeds:", feeds.length);

```

# src\App.jsx

```jsx
import React from 'react'

export default function App() {
  return (
    <div style={{ fontFamily: 'sans-serif', padding: 20 }}>
      <h1>Feedly Clone</h1>
      <p>Basic React app scaffold.</p>
    </div>
  )
}

```

# src\index.css

```css
body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
}

```

# src\main.jsx

```jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')).render(<App />)

```

