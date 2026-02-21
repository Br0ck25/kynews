# API Specification

Base URL (local): `http://127.0.0.1:8787`

## Public Endpoints

### GET /api/health
- Returns service liveness.

### GET /api/feeds
- Query: `scope=ky|national|all` (default `all`)
- Returns enabled feed definitions including `region_scope`.

### GET /api/items
- Query:
  - `scope=ky|national|all` (default `ky`)
  - `feedId?`, `state?`, `county?`, `hours?`, `cursor?`, `limit?`
- Notes:
  - `state/county` filters are valid only for KY scope.

### GET /api/items/:id
- Returns one item.

### GET /api/counties
- Query: `state=KY`, `hours?`
- Returns county counts for KY stories.

### GET /api/search
- Query:
  - `q` required
  - `scope=ky|national|all`
  - `state?`, `county?`, `hours?`, `cursor?`, `limit?`

### GET /api/weather/forecast
- Query: `state=KY`, `county` required
- Returns county forecast periods.

### GET /api/weather/alerts
- Query: `state=KY`, `county?`
- Returns active alerts list.

### GET /api/lost-found
- Query: `type?`, `county?`, `status?`, `limit?`
- Public callers can only access published (`approved`) listings.

### POST /api/lost-found/submissions
- Body:
  - `type`, `title`, `description`, `county`, `state=KY`, `contactEmail`
  - `showContact?`, `imageKeys?`, `turnstileToken?`
- Creates `pending` post.

### POST /api/lost-found/:id/report
- Body: `reason`
- Creates abuse/safety report.

### POST /api/uploads/lost-found-url
- Body: `filename`, `mimeType`
- Returns one-time upload target metadata.

### PUT /api/uploads/lost-found/:key
- Binary upload endpoint for image bytes.

### GET /api/uploads/lost-found/:key
- Returns uploaded image bytes.

## Admin Endpoints

Authentication:
- Production: Cloudflare Access header `cf-access-authenticated-user-email`.
- Local fallback: `x-admin-token` matching `ADMIN_TOKEN`.

### GET /api/admin/lost-found
- Query: `status=pending|approved|rejected`, `limit?`
- Returns moderation queue.

### POST /api/admin/lost-found/:id/approve
- Body: `showContact?`, `note?`

### POST /api/admin/lost-found/:id/reject
- Body: `reason`

### POST /api/admin/feeds/reload
- Triggers one-off ingester run.

## Error Model
- `400` invalid query/payload
- `401` admin auth required
- `404` not found
- `429` rate-limited
- `502` upstream weather error
- `500` internal server error
