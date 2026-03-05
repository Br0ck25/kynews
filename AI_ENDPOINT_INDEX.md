# AI ENDPOINT INDEX

This document lists all API endpoints in the project so AI assistants can quickly locate the correct handler when debugging or implementing changes.

--------------------------------------------------

API ARCHITECTURE

All requests are handled by a Cloudflare Workers `fetch` handler defined
in `worker/src/index.ts` (or the compiled `worker/tmp.js`).

Typical request flow:

```
request
→ router (path detection in the fetch handler)
→ endpoint handler
→ validation
→ database operation
→ JSON response
```

--------------------------------------------------

PUBLIC ENDPOINTS

These routes are consumed by the front‑end and are open to the public.

### GET /api/articles/:category

**Description:**
Returns a list of articles in the requested category. Supported categories are
`today`, `national`, `sports`, `weather`, `schools`, `obituaries` and `all`.
Optional query parameters:

- `counties` or `county` – comma‑separated list of county names
- `search` – full‑text search term
- `limit` – number of items to return (default 20, 100 for `all`)
- `cursor` – pagination cursor

**Handler Location:** `worker/src/index.ts` (see `categoryMatch` block around
lines 1244–1310).

**Database Operations:**
Calls `queryArticles(env, { category, counties, search, limit, cursor })` which
runs a D1 query.

### GET /api/articles/item/:id

**Description:**
Returns a single article by numeric ID.

**Handler Location:** same file (`worker/src/index.ts`, lines 1250–1260).

**Database Operations:**
`getArticleById(env, id)`

### GET /api/articles/slug/:slug

**Description:**
Returns a single article by slug string.

**Handler Location:** `worker/src/index.ts` (lines 1244–1254).

**Database Operations:**
`getArticleBySlug(env, slug)`

*(The classic `/api/articles` root without a category is not used; all public
calls go through the patterns above.)*

--------------------------------------------------

ADMIN ENDPOINTS

Admin routes require authorization (see `isAdminAuthorized` in the fetch
handler) before performing database actions.  Many additional admin paths exist
(`/api/admin/reclassify`, `/api/admin/ingest`, `/api/admin/backfill-*`, etc.),
but the ones most often modified by UI code are listed below.

### POST /api/admin/retag

**Description:**
Update the category/ky flag and county information for an article.

**Expected Input:**
```json
{
  "id": number,
  "category": string,        // may be empty to clear
  "isKentucky": boolean,     // optional
  "county": string|null,
  "counties": string[]       // optional
}
```

**Handler Location:** `worker/src/index.ts` (line ~684).

**Database Operations:**
`updateArticleClassification(env, id, { … })`

### POST /api/admin/article/delete

**Description:**
Deletes an article (optionally blocking it).

**Expected Input:**
```json
{
  "id": number,
  "block": boolean,       // optional
  "reason": string        // optional if blocking
}
```

**Handler Location:** `worker/src/index.ts` (line ~930).

**Database Operations:**
`deleteArticleById(env, id)` or `blockArticleByIdAndDelete(env, id, reason)`

### POST /api/admin/article/update-datetime

**Description:**
Change the published date/time for an article.

**Expected Input:**
```json
{
  "id": number,
  "publishedAt": string    // ISO timestamp
}
```

**Handler Location:** `worker/src/index.ts` (line ~758).

**Database Operations:**
`updateArticlePublishedAt(env, id, isoString)`

### POST /api/admin/article/update-content

**Description:**
Edit the title and/or summary of an article.

**Expected Input:**
```json
{
  "id": number,
  "title": string,        // optional
  "summary": string       // optional
}
```

**Handler Location:** `worker/src/index.ts` (line ~819).

**Database Operations:**
`updateArticleContent(env, id, { title, summary })`

### POST /api/admin/article/update-links

**Description:**
Change canonical/source URLs for an article (performs duplicate‑URL check).

**Expected Input:**
```json
{
  "id": number,
  "canonicalUrl": string, // optional
  "sourceUrl": string     // optional
}
```

**Handler Location:** `worker/src/index.ts` (line ~886).

**Database Operations:**
`updateArticleLinks(env, id, { canonicalUrl, sourceUrl, urlHash })`


Other admin endpoints (listing articles, blocked items, metrics, etc.) can be
found in the same file; search for `/api/admin/` to explore.

--------------------------------------------------

DATABASE ACCESS PATTERN

Database engine: Cloudflare D1 (SQLite)

Typical usage pattern in handlers:

```js
const stmt = env.DB.prepare(query);
stmt.bind(values);
const result = await stmt.run();        // or .first()
```

Helpers in `worker/src/lib/db.ts` encapsulate most common queries and are
imported into the fetch handler.

--------------------------------------------------

DEBUGGING INSTRUCTIONS FOR AI

When an endpoint fails:

1. Locate the endpoint in this index and note the handler file/line range.
2. Open the corresponding section in `worker/src/index.ts` (or `worker/tmp.js` if
   you're inspecting compiled code).
3. Trace execution inside the handler, watching for validation or auth checks.
4. Identify the failing database call or logic.
5. Apply the minimal fix, keeping changes confined to that handler.
6. Run the worker tests (`worker/test/index.spec.ts`) to ensure no regressions.

Avoid touching unrelated endpoints and preserve the existing routing style.
