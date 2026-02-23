# Location Tagging

Location tagging is defined in:

- `docs/05_INGESTION_PIPELINE.md`
- `ky-news-worker/src/ingest/ingest.ts` (`writeItemLocations`)
- `ky-news-worker/src/services/location.ts` (`detectKyCounties`)

Current behavior:
- Kentucky feeds receive state + county tags.
- National feeds do not enter county navigation.
- `default_county` on a feed is always tagged for KY-scope items.
- Facebook school feeds (`fetch_mode=facebook-page`) skip body-analysis county extraction and rely on feed scope metadata.

Recent output-policy updates (Feb 2026):
- County pages now use deduped API results (no unfiltered duplicate-prone mode).
- National supports an include-all mode (`/api/items?scope=national&includeAll=1`) that keeps dedupe while bypassing curation gates.
- Weather and Obituaries category feeds are enforced with strict topic filtering at API output.
- Manual admin ingestion (`POST /api/admin/feeds/reload`) now starts asynchronously and should be monitored via ingestion logs/health endpoints.
