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
