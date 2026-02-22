import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppBindings, Env } from "./types";
import { ApiError } from "./lib/errors";
import { logError, logInfo } from "./lib/logger";
import { ensureSchema } from "./services/schema";
import { registerNewsRoutes } from "./routes/news";
import { registerWeatherRoutes } from "./routes/weather";
import { registerLostFoundRoutes } from "./routes/lostFound";
import { registerAdminRoutes } from "./routes/admin";
import { runScheduledIngest } from "./ingest/ingest";
import { getAdminIdentity, enforceBotProtection, enforceGlobalRequestRateLimit } from "./services/security";
import { incrementDailyMetric, purgeExpiredErrorEvents, recordErrorEvent, writeStructuredLog } from "./services/observability";

const app = new Hono<AppBindings>();

function resolveCorsOrigins(value?: string): string[] {
  if (!value) {
    return ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"];
  }
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

app.use("*", async (c, next) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.set("startTime", started);
  const pathname = new URL(c.req.url).pathname;

  const origins = resolveCorsOrigins(c.env.CORS_ORIGINS);
  const corsMiddleware = cors({
    origin: (origin) => {
      if (!origin) return origins[0] || "*";
      return origins.includes(origin) ? origin : origins[0] || "*";
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "x-admin-token", "cf-access-authenticated-user-email"],
    exposeHeaders: ["x-request-id"],
    maxAge: 86400
  });

  await corsMiddleware(c, async () => {
    if (pathname !== "/" && pathname !== "/api/health") {
      await ensureSchema(c.env);
    }

    if (c.req.method !== "OPTIONS") {
      const actor = getAdminIdentity(c);
      if (actor) c.set("actorEmail", actor.email);
      await enforceGlobalRequestRateLimit(c);
      enforceBotProtection(c);
    }

    await next();
  });

  c.header("x-request-id", requestId);

  const durationMs = Date.now() - started;
  logInfo("http.request", {
    requestId,
    method: c.req.method,
    path: pathname,
    status: c.res.status,
    durationMs
  });

  c.executionCtx.waitUntil(
    Promise.all([
      writeStructuredLog(c.env, {
        level: c.res.status >= 500 ? "error" : c.res.status >= 400 ? "warn" : "info",
        event: "http.request",
        ts: new Date().toISOString(),
        requestId,
        route: pathname,
        method: c.req.method,
        status: c.res.status,
        actorEmail: c.get("actorEmail"),
        data: { durationMs }
      }),
      incrementDailyMetric(c.env, "http.requests", 1),
      c.res.status >= 500 ? incrementDailyMetric(c.env, "http.server_errors", 1) : Promise.resolve(0),
      c.res.status >= 400 && c.res.status < 500
        ? incrementDailyMetric(c.env, "http.client_errors", 1)
        : Promise.resolve(0)
    ]).then(() => undefined)
  );
});

app.onError((err, c) => {
  const requestId = c.get("requestId");
  const pathname = new URL(c.req.url).pathname;
  const actorEmail = c.get("actorEmail");

  if (err instanceof ApiError) {
    const payload: Record<string, unknown> = { error: err.message };
    if (err.details !== undefined) payload.details = err.details;
    c.executionCtx.waitUntil(
      recordErrorEvent(c.env, {
        requestId,
        route: pathname,
        method: c.req.method,
        statusCode: err.status,
        actorEmail,
        errorMessage: err.message,
        meta: err.details ? { details: err.details } : undefined
      })
    );
    return c.json(payload, { status: err.status as any });
  }

  logError("http.unhandled", err, {
    requestId,
    method: c.req.method,
    path: pathname
  });

  c.executionCtx.waitUntil(
    recordErrorEvent(c.env, {
      requestId,
      route: pathname,
      method: c.req.method,
      statusCode: 500,
      actorEmail,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error ? err.stack : undefined
    })
  );

  return c.json({ error: "Internal server error" }, 500 as 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

registerNewsRoutes(app);
registerWeatherRoutes(app);
registerLostFoundRoutes(app);
registerAdminRoutes(app);

app.get("/", (c) => c.json({ ok: true, service: c.env.APP_NAME || "EKY News Worker" }));

// Serve robots.txt so crawlers receive valid directives instead of HTML from the SPA
app.get("/robots.txt", (c) => {
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", "public, max-age=86400");
  return c.text("User-agent: *\nAllow: /\n");
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    await ensureSchema(env);
    ctx.waitUntil(
      Promise.all([
        runScheduledIngest(env),
        purgeExpiredErrorEvents(env),
        incrementDailyMetric(env, "scheduler.ticks", 1)
      ]).then(() => undefined)
    );
  }
} satisfies ExportedHandler<Env>;
