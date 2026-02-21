import type { Context } from "hono";

export type NewsScope = "ky" | "national" | "all";

export interface WorkersAI {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  ky_news_db: D1Database;
  ky_news_media: R2Bucket;
  CACHE: KVNamespace;
  AI: WorkersAI;
  APP_NAME?: string;
  NWS_USER_AGENT?: string;
  ADMIN_TOKEN?: string;
  ADMIN_EMAIL?: string;
  DATA_ENCRYPTION_KEY?: string;
  REQUIRE_TURNSTILE?: string;
  LOST_FOUND_AUTO_APPROVE?: string;
  RSS_USER_AGENT?: string;
  AI_MODEL?: string;
  SUMMARY_CACHE_TTL_SECONDS?: string;
  MAX_INGEST_ITEMS_PER_FEED?: string;
  MAX_FEEDS_PER_RUN?: string;
  CORS_ORIGINS?: string;
  API_CACHE_TTL_SECONDS?: string;
  LOG_TTL_SECONDS?: string;
  ERROR_EVENT_TTL_DAYS?: string;
  RATE_LIMIT_READ_PER_MIN?: string;
  RATE_LIMIT_WRITE_PER_MIN?: string;
  RATE_LIMIT_ADMIN_PER_MIN?: string;
  BOT_SCORE_MIN?: string;
  ADMIN_EMAILS?: string;
  EDITOR_EMAILS?: string;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    requestId: string;
    startTime: number;
    actorEmail?: string;
  };
};

export type AppContext = Context<AppBindings>;

export interface AdminIdentity {
  email: string;
  source: "cloudflare-access" | "admin-token";
  role: "admin" | "editor";
}
