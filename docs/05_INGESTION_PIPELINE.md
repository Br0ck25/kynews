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
