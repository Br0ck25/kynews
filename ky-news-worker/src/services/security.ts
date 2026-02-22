import { randomUUID } from "node:crypto";
import type { AppContext, AdminIdentity, Env } from "../types";
import { forbidden, tooManyRequests, unauthorized } from "../lib/errors";
import { d1Run } from "./db";
import { hashIp } from "../lib/crypto";
import { logWarn } from "../lib/logger";

type AdminRole = "admin" | "editor";

function parseCsvSet(value: string | undefined): Set<string> {
  return new Set(
    String(value || "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
}

function roleRank(role: AdminRole): number {
  return role === "admin" ? 2 : 1;
}

export function getAdminIdentity(c: AppContext): AdminIdentity | null {
  const cfEmail = c.req.header("cf-access-authenticated-user-email");
  if (cfEmail) {
    const normalized = String(cfEmail).trim().toLowerCase();
    const admins = parseCsvSet(c.env.ADMIN_EMAILS);
    const editors = parseCsvSet(c.env.EDITOR_EMAILS);

    if (admins.has(normalized)) {
      return { email: normalized, source: "cloudflare-access", role: "admin" };
    }
    if (editors.has(normalized)) {
      return { email: normalized, source: "cloudflare-access", role: "editor" };
    }
    return null;
  }

  const headerToken = c.req.header("x-admin-token");
  const adminToken = c.env.ADMIN_TOKEN;
  if (adminToken && headerToken && headerToken === adminToken) {
    return { email: c.env.ADMIN_EMAIL || "worker-admin", source: "admin-token", role: "admin" };
  }

  return null;
}

export function requireAdmin(c: AppContext): AdminIdentity {
  const identity = getAdminIdentity(c);
  if (!identity) unauthorized("Admin authentication required");
  return identity;
}

export function requireRole(c: AppContext, role: AdminRole): AdminIdentity {
  const identity = requireAdmin(c);
  if (roleRank(identity.role) < roleRank(role)) {
    forbidden("Insufficient role");
  }
  return identity;
}

export async function insertAdminLog(
  env: Env,
  actorEmail: string,
  action: string,
  entityType: string,
  entityId: string,
  payload: unknown = null
): Promise<void> {
  try {
    await d1Run(
      env.ky_news_db,
      "INSERT INTO admin_audit_log (id, actor_email, action, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      [randomUUID(), actorEmail, action, entityType, entityId, payload == null ? null : JSON.stringify(payload)]
    );
  } catch (err) {
    logWarn("admin.audit.log_failed", {
      action,
      entityType,
      entityId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export function getClientIp(c: AppContext): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export async function enforceRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetInSec: number }> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const cacheKey = `rl:v2:${key}:${bucket}`;
  const current = Number(await env.CACHE.get(cacheKey));
  const used = Number.isFinite(current) ? current : 0;

  if (used >= limit) {
    return { allowed: false, remaining: 0, resetInSec: windowSeconds };
  }

  const next = used + 1;
  await env.CACHE.put(cacheKey, String(next), { expirationTtl: windowSeconds + 30 });
  return { allowed: true, remaining: Math.max(0, limit - next), resetInSec: windowSeconds };
}

export async function enforceGlobalRequestRateLimit(c: AppContext): Promise<void> {
  const ip = getClientIp(c);
  const path = new URL(c.req.url).pathname;
  const isAdmin = path.startsWith("/api/admin/");
  const isWrite = c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS";

  const readLimit = Number(c.env.RATE_LIMIT_READ_PER_MIN || "240");
  const writeLimit = Number(c.env.RATE_LIMIT_WRITE_PER_MIN || "60");
  const adminLimit = Number(c.env.RATE_LIMIT_ADMIN_PER_MIN || "90");

  const bucketType = isAdmin ? "admin" : isWrite ? "write" : "read";
  const limit = bucketType === "admin" ? adminLimit : bucketType === "write" ? writeLimit : readLimit;

  const result = await enforceRateLimit(c.env, `${bucketType}:${ip}`, Number.isFinite(limit) ? limit : 120, 60);
  c.header("x-ratelimit-remaining", String(result.remaining));
  c.header("x-ratelimit-reset-sec", String(result.resetInSec));

  if (!result.allowed) {
    tooManyRequests("Rate limit exceeded");
  }
}

export function enforceBotProtection(c: AppContext): void {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method.toUpperCase();
  const guarded = path.startsWith("/api/admin/") || method !== "GET" || path === "/api/open-proxy";
  if (!guarded) return;

  const cf = (c.req.raw as any)?.cf;
  const verifiedBot = Boolean(cf?.botManagement?.verifiedBot);
  if (verifiedBot) return;

  const headerScore = Number(c.req.header("cf-bot-score"));
  const cfScoreRaw = cf?.botManagement?.score;
  const cfScore = Number.isFinite(Number(cfScoreRaw)) ? Number(cfScoreRaw) : headerScore;

  const thresholdRaw = Number(c.env.BOT_SCORE_MIN || "18");
  const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 18;
  if (Number.isFinite(cfScore) && cfScore < threshold) {
    logWarn("security.bot.blocked", { path, method, score: cfScore, threshold });
    forbidden("Request blocked by bot protection");
  }

  const userAgent = c.req.header("user-agent") || "";
  if (!userAgent.trim() && guarded) {
    forbidden("Missing user-agent");
  }
}

export async function enforceSubmissionRateLimit(env: Env, ip: string): Promise<boolean> {
  const ipKey = await hashIp(ip || "unknown");
  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const key = `rl:lost-found:${ipKey}:${bucket}`;
  const current = Number(await env.CACHE.get(key));
  if (Number.isFinite(current) && current >= 5) {
    return false;
  }

  const next = Number.isFinite(current) ? current + 1 : 1;
  await env.CACHE.put(key, String(next), { expirationTtl: 2 * 60 * 60 });
  return true;
}
