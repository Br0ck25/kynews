# New Backend — Node.js HTTP Server + Ingestion Pipeline

This directory contains the **production replacement** for `apps/api/` plus a full
ingestion pipeline that runs on both Node.js (SQLite) and Cloudflare Workers (D1).

---

## Architecture

```
New Backend/
├── server.mjs          ← Fastify HTTP server (runs in Node.js, replaces apps/api/src/server.mjs)
├── migrate-sqlite.mjs  ← One-time idempotent DB migration script
├── scheduler.mjs       ← Node.js cron scheduler (mirrors Cloudflare Worker cron triggers)
├── db-adapter.mjs      ← DB abstraction: SQLite (Node.js) or D1 (Cloudflare)
├── queries.mjs         ← Category-based article query builder
├── ingestion-v3.mjs    ← Feed ingestion + DB migration SQL
├── body-worker-v2.mjs  ← Article body fetch + AI summarization worker
├── bing-fallback-worker.mjs ← Bing RSS fallback feed sync
├── breaking.mjs        ← Breaking news detection
├── dedup.mjs           ← MinHash duplicate detection
├── paywall.mjs         ← Paywall signal detection
├── alerting.mjs        ← Coverage gap + feed failure alerting
├── legislature.mjs     ← KY legislature bill scraper
├── legislature-worker.mjs  ← Legislature worker runner
├── school-calendar.mjs     ← School event calendar sync (ICS)
├── school-calendar-worker.mjs ← School calendar worker runner
└── coverage-report.mjs     ← Coverage report generator
```

### Key Design Decisions

| Concern | Approach |
|---|---|
| **DB Access** | `db-adapter.mjs` wraps better-sqlite3 (sync) or D1 (async) behind one interface |
| **Sub-modules** (weather / lostFound / seo) | These call `openDb()` synchronously; `server.mjs` passes a thin `syncOpenDb()` factory backed by better-sqlite3 directly |
| **Schema evolution** | `migrate-sqlite.mjs` adds new columns/tables idempotently — safe to re-run |
| **Route compatibility** | All routes from `apps/api/src/server.mjs` are preserved 1-to-1 |
| **Encryption** | `LOCAL_DATA_ENCRYPTION_KEY` logic unchanged — imports `security.mjs` from apps/api |
| **Region scope** | `region_scope = 'ky' / 'national'` semantics fully preserved |
| **County filtering** | `item_locations` table and all county filter logic preserved |

---

## Quick Start

### 1. Install dependencies

```bash
cd "New Backend"
npm install
```

### 2. Run the database migration (once, before first server start)

```bash
# From repo root:
node "New Backend/migrate-sqlite.mjs"

# Or from New Backend/:
npm run migrate
```

This script is **idempotent** — already-applied columns/tables are skipped.
It **never drops data**, never removes columns, and is safe to re-run at any time.

Expected output:
```
🔧  migrate-sqlite.mjs
   DB: /path/to/data/dev.sqlite

[1/9] Items — dedup columns
  ✅  ADD   ALTER TABLE items ADD COLUMN minhash
  ✅  ADD   ALTER TABLE items ADD COLUMN is_duplicate
  ...
✅  Migration complete.
   Applied : 32
   Skipped : 0
```

### 3. Start the HTTP server

```bash
# From repo root:
node "New Backend/server.mjs"

# Or:
cd "New Backend" && npm run server

# With file watching (dev):
npm run server:dev
```

The server listens on `http://127.0.0.1:8787` by default.

### 4. Start the scheduler (separate terminal)

```bash
node "New Backend/scheduler.mjs"

# Or:
cd "New Backend" && npm run scheduler
```

The scheduler runs all ingestion tasks on the same cron schedule as the
Cloudflare Worker (`wrangler.toml`).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DB_PATH` | `data/dev.sqlite` | Path to the SQLite database file |
| `PORT` | `8787` | HTTP server listen port |
| `HOST` | `127.0.0.1` | HTTP server bind address |
| `LOCAL_DATA_ENCRYPTION_KEY` | `dev-only-change-me` | AES-256-GCM key for PII encryption |
| `ADMIN_TOKEN` | *(none)* | Bearer token for admin routes |
| `ADMIN_EMAIL` | `local-admin` | Email label for admin-token auth |
| `SITE_URL` | `https://localky.news` | Canonical site URL for sitemap/robots |
| `SITE_ORIGIN` | `https://localkynews.com` | Origin for SEO routes (RSS/JSON-LD) |
| `NWS_USER_AGENT` | `EasternKentuckyNews/1.0` | User-Agent for NWS weather API |
| `REQUIRE_TURNSTILE` | *(unset)* | Set `"1"` to require CF Turnstile on lost-found submissions |
| `SLACK_WEBHOOK_URL` | *(none)* | Slack webhook for alerting |
| `LOG_LEVEL` | *(unset)* | Set `"silent"` to suppress scheduler logs |

### Example `.env` file (development)

```env
DB_PATH=data/dev.sqlite
PORT=8787
HOST=127.0.0.1
LOCAL_DATA_ENCRYPTION_KEY=change-this-to-a-random-secret
ADMIN_TOKEN=local-admin-token
ADMIN_EMAIL=dev@example.com
SITE_URL=http://localhost:5173
SITE_ORIGIN=http://localhost:5173
```

---

## API Routes

All routes from the original `apps/api/src/server.mjs` are preserved:

| Method | Route | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/items` | Article list (county / scope / cursor pagination) |
| GET | `/api/articles` | Alias for `/api/items` |
| GET | `/api/items/:id` | Single article |
| GET | `/api/search` | Full-text search |
| GET | `/api/counties` | County article counts |
| GET | `/api/feeds` | Enabled feed list |
| POST | `/api/feeds` | Create feed (admin) |
| PUT | `/api/feeds/:id` | Update feed (admin) |
| DELETE | `/api/feeds/:id` | Delete feed (admin) |
| GET | `/api/stats` | Item/feed statistics |
| POST | `/api/ingest` | Manual ingestion trigger (admin) |
| GET | `/api/open-proxy` | Sandboxed HTML proxy |
| GET | `/api/weather/forecast` | NWS county forecast |
| GET | `/api/weather/alerts` | NWS weather alerts |
| GET | `/api/lost-found` | Lost & found listings |
| POST | `/api/lost-found/submissions` | New lost/found submission |
| GET | `/api/lost-found/:id/comments` | Post comments |
| POST | `/api/lost-found/:id/comments` | Add comment |
| POST | `/api/lost-found/:id/report` | Report a post |
| POST | `/api/lost-found/:id/mark-found` | Mark lost post as found |
| GET | `/api/admin/lost-found` | Admin: all posts (admin) |
| POST | `/api/admin/lost-found/:id/approve` | Approve post (admin) |
| POST | `/api/admin/lost-found/:id/reject` | Reject post (admin) |
| DELETE | `/api/admin/lost-found/:id` | Delete post (admin) |
| GET | `/api/admin/lost-found/comments` | All comments (admin) |
| POST | `/api/admin/lost-found/comments/:id/ban` | Ban commenter (admin) |
| GET | `/api/admin/lost-found/bans` | Comment bans list (admin) |
| DELETE | `/api/admin/lost-found/bans/:id` | Remove ban (admin) |
| DELETE | `/api/admin/lost-found/comments/:id` | Delete comment (admin) |
| POST | `/api/admin/feeds/reload` | Re-run ingester (admin) |
| POST | `/api/admin/items/revalidate` | Retag items (admin) |
| GET | `/api/admin/audit-log` | Audit log (admin) |
| GET | `/api/admin/feeds` | Feed list with status (admin) |
| GET | `/api/admin/items` | Item list (admin) |
| GET | `/api/admin/coverage` | County coverage report (admin) |
| GET | `/sitemap.xml` | Legacy sitemap |
| GET | `/robots.txt` | robots.txt |
| GET | `/sitemap-index.xml` | Sitemap index |
| GET | `/sitemap-news.xml` | Google News sitemap |
| GET | `/sitemap-counties.xml` | County sitemaps |
| GET | `/sitemap-lost-found.xml` | Lost & found sitemap |
| GET | `/sitemap-static.xml` | Static page sitemap |
| GET | `/rss.xml` | Global KY RSS feed |
| GET | `/rss/:county.xml` | Per-county RSS feed |
| GET | `/api/structured-data/item/:id` | JSON-LD for article |
| GET | `/api/structured-data/county/:county` | JSON-LD for county |
| GET | `/api/uploads/lost-found/:key` | Serve uploaded image |
| POST | `/api/uploads/lost-found-url` | Get upload URL |
| PUT | `/api/uploads/lost-found/:key` | Upload image binary |

---

## Rollback

The new backend runs **alongside** the old `apps/api/` server — they share the same
SQLite database file. To roll back:

1. **Stop the new server** (`Ctrl+C` or kill the process).
2. **Start the old server**:
   ```bash
   cd apps/api
   node src/server.mjs
   ```
3. The `data/dev.sqlite` file is unaffected — all new columns added by
   `migrate-sqlite.mjs` have `DEFAULT` values and do not break the old schema
   or old queries.

### What the migration adds (never removes)

- **New columns on `items`:** `minhash`, `is_duplicate`, `canonical_item_id`,
  `is_paywalled`, `paywall_confidence`, `paywall_signals`, `paywall_deprioritized`,
  `is_breaking`, `alert_level`, `sentiment`, `breaking_expires_at`,
  `ai_meta_description`, `word_count`, `categories_json`, `is_facebook`
- **New column on `feeds`:** `is_bing_fallback`
- **New tables:** `ky_bills`, `article_bills`, `school_events`, `alert_log`,
  `item_categories`, `ingestion_queue`, `fetch_errors`
- **All existing tables, columns, and data are untouched.**

---

## Cloudflare Workers Deployment

To deploy the ingestion pipeline (not the HTTP server) to Cloudflare Workers:

```bash
cd "New Backend"
wrangler deploy
```

The D1 database ID is `f1669001-2a51-4114-a84e-73cfa7f1c584`.

Apply D1 migrations:
```bash
wrangler d1 execute ky-news --file ingestion-v3.sql
```

---

## Scheduler Task Reference

| Task | Interval | Description |
|---|---|---|
| `feed-ingestion` | Every 15 min | Fetch all RSS feeds and upsert items |
| `body-worker` | Every 5 min | Fetch article bodies + AI summaries |
| `school-calendar` | Every 6 hours | Sync ICS school event calendars |
| `legislature` | Daily 8 AM UTC | Scrape KY legislature bills |
| `coverage-alerts` | Daily 4 AM UTC | Alert on coverage gaps + feed failures |
| `rss-discovery` | Weekly Sun 3 AM UTC | Auto-discover new RSS feeds |
| `bing-fallback` | Daily 6 AM UTC | Sync Bing RSS fallback feeds |
