import { randomUUID } from "node:crypto";
import type { Env } from "../types";
import { d1Run } from "./db";

export type LogLevel = "info" | "warn" | "error";

export type StructuredLog = {
  level: LogLevel;
  event: string;
  ts: string;
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  actorEmail?: string;
  data?: Record<string, unknown>;
};

function dayStamp(ts: string): string {
  return ts.slice(0, 10);
}

function logTtlSeconds(env: Env): number {
  const configured = Number(env.LOG_TTL_SECONDS || "1209600");
  return Number.isFinite(configured) && configured > 0 ? configured : 14 * 24 * 60 * 60;
}

function metricTtlSeconds(): number {
  return 60 * 24 * 60 * 60;
}

function makeLogKey(event: string, ts: string): string {
  return `log:v1:${dayStamp(ts)}:${event}:${Date.now()}:${randomUUID()}`;
}

export async function writeStructuredLog(env: Env, log: StructuredLog): Promise<void> {
  const key = makeLogKey(log.event, log.ts);
  await env.CACHE.put(key, JSON.stringify(log), { expirationTtl: logTtlSeconds(env) });
}

export async function recordErrorEvent(
  env: Env,
  input: {
    requestId?: string;
    route?: string;
    method?: string;
    statusCode?: number;
    actorEmail?: string;
    errorMessage: string;
    errorStack?: string;
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  const retentionDaysRaw = Number(env.ERROR_EVENT_TTL_DAYS || "30");
  const retentionDays = Number.isFinite(retentionDaysRaw) && retentionDaysRaw > 0 ? retentionDaysRaw : 30;

  await d1Run(
    env.ky_news_db,
    `
    INSERT INTO app_error_events (
      id, request_id, route, method, status_code, actor_email, error_message, error_stack, meta_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', ?))
    `,
    [
      randomUUID(),
      input.requestId || null,
      input.route || null,
      input.method || null,
      input.statusCode || null,
      input.actorEmail || null,
      input.errorMessage.slice(0, 4000),
      input.errorStack ? input.errorStack.slice(0, 12_000) : null,
      input.meta ? JSON.stringify(input.meta) : null,
      `+${retentionDays} days`
    ]
  );

  await writeStructuredLog(env, {
    level: "error",
    event: "app.error",
    ts: new Date().toISOString(),
    requestId: input.requestId,
    route: input.route,
    method: input.method,
    status: input.statusCode,
    actorEmail: input.actorEmail,
    data: {
      message: input.errorMessage,
      stack: input.errorStack,
      ...(input.meta || {})
    }
  });
}

export async function incrementDailyMetric(
  env: Env,
  metric: string,
  delta = 1,
  day = new Date().toISOString().slice(0, 10)
): Promise<number> {
  const key = `metric:v1:${day}:${metric}`;
  const currentRaw = await env.CACHE.get(key);
  const current = Number(currentRaw);
  const next = (Number.isFinite(current) ? current : 0) + delta;
  await env.CACHE.put(key, String(next), { expirationTtl: metricTtlSeconds() });
  return next;
}

export async function incrementMetricGroup(
  env: Env,
  group: string,
  fields: Record<string, number>,
  day = new Date().toISOString().slice(0, 10)
): Promise<void> {
  const entries = Object.entries(fields);
  await Promise.all(entries.map(([field, delta]) => incrementDailyMetric(env, `${group}.${field}`, delta, day)));
}

export async function purgeExpiredErrorEvents(env: Env): Promise<void> {
  await d1Run(env.ky_news_db, "DELETE FROM app_error_events WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')");
}
