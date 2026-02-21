# Product Requirements

## Screens and Behaviors

### Today
- Default route `/today`.
- Shows Kentucky stories by recency.
- Supports optional query filters: `state=KY`, `county=<name>`.
- Infinite paging via cursor.

### Kentucky Local
- Drawer access to Kentucky state view and all counties.
- County counts shown from `/api/counties`.
- My Local county preference stored in localStorage.

### National
- Dedicated route `/national`.
- Only stories with `region_scope=national`.
- No county drilldown in National.

### Weather
- Route `/weather`.
- Uses My Local county by default.
- Forecast periods from NWS.
- Active alert list with severity and event.

### Search
- Route `/search`.
- Query syntax supports quoted phrases, `AND`, `OR`, `-exclude`.
- Scope picker: Kentucky, National, Both.

### Reader
- Route `/item/:id`.
- Displays cleaned content with source link.
- Supports offline fallback from local cache.

### Read Later
- Route `/read-later`.
- Device-local saved state with mark-all-read.

### Lost & Found
- Route `/lost-found`.
- Public listing shows approved posts only.
- Submission form requires: type, title, description, county, contact email.
- Optional image upload and optional contact visibility after approval.

## Interaction Requirements
- Mobile-first layout with drawer nav + bottom nav.
- Quick county switching and persistent My County setting.
- Clear loading/error states for all data-heavy screens.

## Reliability Requirements
- App remains usable if some feeds fail.
- Weather endpoint can return stale cached data if NWS is temporarily unavailable.
- Lost-and-found submission rate-limited per IP.

## Security Requirements
- Admin endpoints protected by Cloudflare Access header in production.
- Local admin fallback supported via `ADMIN_TOKEN`.
- Contact email encrypted at rest.

## Non-Functional Targets
- Initial content load under 2.5s on typical mobile 4G.
- API P95 under 600ms for core feed endpoints (excluding upstream weather latency).
- Ingestion cadence every 15 minutes.
