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
  try {
    db.prepare(
      "INSERT INTO admin_audit_log (id, actor_email, action, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(randomUUID(), actorEmail, action, entityType, entityId, payload ? JSON.stringify(payload) : null);
  } catch (err) {
    console.warn("admin.audit.log_failed", {
      action,
      entityType,
      entityId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
