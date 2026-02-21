# EKY News Cloudflare Worker Backend

Production Worker backend for EKY News using Hono + D1 + R2 + KV + Workers AI.

## Features

- Frontend-compatible API routes (`/api/*`) from the existing Node backend
- D1-backed queries replacing local SQLite
- Scheduled RSS ingestion every 15 minutes (`cron`)
- AI-generated full summaries using Workers AI
- Summary cache in KV to avoid repeated inference
- Lost/found and article image storage in R2
- Admin dashboard APIs: ingestion logs, feed health, manual triggers, summary review queue, tag corrections
- Structured request/error logging persisted to KV
- Error tracking and ingestion metrics persisted to D1
- Security middleware: global rate limiting, bot protection, role-based admin auth
- Edge caching headers and keyset pagination for high-volume listing endpoints

## Project Structure

```text
ky-news-worker/
  migrations/
    0001_initial.sql
    0002_seed_feeds.sql
    0003_admin_observability_perf_security.sql
  scripts/
    generate-feed-seed-sql.mjs
  src/
    index.ts
    types.ts
    ingest/
      ingest.ts
    lib/
      crypto.ts
      errors.ts
      logger.ts
      search.ts
      utils.ts
    routes/
      admin.ts
      lostFound.ts
      news.ts
      weather.ts
    services/
      article.ts
      db.ts
      location.ts
      media.ts
      observability.ts
      rss.ts
      apiCache.ts
      schema.ts
      security.ts
      summary.ts
      weather.ts
    data/
      ky-counties.json
      ky-city-county.json
  wrangler.jsonc
  package.json
```

## API Compatibility

Implemented endpoints:

- `GET /api/health`
- `GET /api/feeds`
- `GET /api/items`
- `GET /api/items/:id`
- `GET /api/search`
- `GET /api/counties`
- `GET /api/open-proxy`
- `GET /api/weather/forecast`
- `GET /api/weather/alerts`
- `GET /api/uploads/lost-found/:key`
- `POST /api/uploads/lost-found-url`
- `PUT /api/uploads/lost-found/:key`
- `GET /api/lost-found`
- `POST /api/lost-found/submissions`
- `POST /api/lost-found/:id/report`
- `GET /api/admin/lost-found`
- `POST /api/admin/lost-found/:id/approve`
- `POST /api/admin/lost-found/:id/reject`
- `POST /api/admin/feeds/reload`
- `POST /api/admin/feeds/:id/trigger`
- `GET /api/admin/ingestion/logs`
- `GET /api/admin/feeds/health`
- `GET /api/admin/summaries/review`
- `POST /api/admin/summaries/:itemId/review`
- `GET /api/admin/items/:id/tags`
- `PUT /api/admin/items/:id/tags`
- `GET /api/admin/tags/corrections`
- `GET /api/admin/metrics/ingestion`
- `GET /api/admin/errors`
- `GET /api/admin/logs/kv`

Additional Worker-native endpoint:

- `GET /api/media/:key` (serves mirrored article media from R2)

## Local Development

```bash
cd ky-news-worker
npm install
npm run dev
```

## Database Setup (D1)

### Fresh D1 setup

```bash
cd ky-news-worker
wrangler d1 execute ky-news-db --file=migrations/0001_initial.sql
wrangler d1 execute ky-news-db --file=migrations/0002_seed_feeds.sql
wrangler d1 execute ky-news-db --file=migrations/0003_admin_observability_perf_security.sql
```

### If you already imported your local schema

Run only the Worker schema upgrade and feed seed as needed:

```bash
cd ky-news-worker
wrangler d1 execute ky-news-db --file=migrations/0001_initial.sql
wrangler d1 execute ky-news-db --file=migrations/0002_seed_feeds.sql
wrangler d1 execute ky-news-db --file=migrations/0003_admin_observability_perf_security.sql
```

`0001_initial.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) and safe to run repeatedly.

## Secrets and Environment

Set secrets before deployment:

```bash
cd ky-news-worker
wrangler secret put ADMIN_TOKEN
wrangler secret put DATA_ENCRYPTION_KEY
```

Optional:

- `ADMIN_EMAIL` (secret or env var)
- `ADMIN_EMAILS` (comma-separated emails with full admin role)
- `EDITOR_EMAILS` (comma-separated emails with editor role)
- `REQUIRE_TURNSTILE=1` (env var when Turnstile enforcement is enabled)
- `CORS_ORIGINS` (comma-separated list)

Configured bindings in `wrangler.jsonc`:

- D1: `ky_news_db`
- R2: `ky_news_media`
- KV: `CACHE`
- AI: `AI`

## Deploy

```bash
cd ky-news-worker
npm run typecheck
npm test
npm run deploy
```

Deployment target:

- Worker: `ky-news-worker`
- URL: `https://ky-news-worker.jamesbrock25.workers.dev`

## Operational Notes

- Scheduled ingestion runs every 15 minutes via Wrangler cron.
- Manual ingestion can be triggered via `POST /api/admin/feeds/reload` with admin auth.
- Single-feed ingestion can be triggered via `POST /api/admin/feeds/:id/trigger`.
- AI summaries are cached in KV (`summary:v1:<itemId>`) and persisted to D1.
- AI summaries enter `summary_review_queue` for admin/editor review.
- Mirrored article images are saved in R2 under `news/*` and served from `/api/media/*`.
- Lost/found uploads are saved in R2 under `lost-found/*`.
