# AI ENDPOINT INDEX

This document lists all known API endpoints so AI assistants can quickly locate the correct handler when debugging or building features.

Read AI_PROJECT_MEMORY.md for rules and patterns before making any changes.
Read AI_PROJECT_MAP.md to understand how files connect.

--------------------------------------------------

API ARCHITECTURE

All requests are handled by the fetch handler in worker/src/index.ts.

Request flow:

request
→ fetch handler (worker/src/index.ts)
→ path detection
→ isAdminAuthorized() — admin routes only, always called first
→ validation
→ database helper (worker/src/lib/db.ts)
→ json() or badRequest() (worker/src/lib/http.ts)
→ response

--------------------------------------------------

RESPONSE RULES

Every endpoint must respond using helpers from worker/src/lib/http.ts.

Success:   json(data)
Failure:   badRequest(message)

Never construct a raw Response object.
Never return a plain string.

--------------------------------------------------

PUBLIC ENDPOINTS

These routes are open to the public and consumed by the frontend.

--------------------------------------------------

GET /api/articles/:category

Returns a list of articles for the given category.

Supported category values:
  today | national | sports | weather | schools | obituaries | all

Optional query parameters:
  counties   — comma-separated county names
  county     — single county name
  search     — full-text search term
  limit      — number of results (default 20, max 100 for "all")
  cursor     — pagination cursor

Handler: worker/src/index.ts — categoryMatch block (~lines 1244–1310)
Database: queryArticles(env, { category, counties, search, limit, cursor })

--------------------------------------------------

GET /api/articles/item/:id

Returns a single article by numeric ID.

Handler: worker/src/index.ts (~lines 1250–1260)
Database: getArticleById(env, id)

--------------------------------------------------

GET /api/articles/slug/:slug

Returns a single article by slug string.

Handler: worker/src/index.ts (~lines 1244–1254)
Database: getArticleBySlug(env, slug)

--------------------------------------------------

ADMIN ENDPOINTS

All admin routes require isAdminAuthorized() to be called before any database operation.
Never add an admin route without this check.

--------------------------------------------------

POST /api/admin/retag

Updates the category, Kentucky flag, and county data for an article.

Input:
{
  "id": number,
  "category": string,       — may be empty string to clear
  "isKentucky": boolean,    — optional
  "county": string | null,
  "counties": string[]      — optional
}

Handler: worker/src/index.ts (~line 684)
Database: updateArticleClassification(env, id, { … })

--------------------------------------------------

POST /api/admin/article/delete

Deletes an article. Optionally blocks it to prevent re-ingestion.

Input:
{
  "id": number,
  "block": boolean,         — optional
  "reason": string          — required if block is true
}

Handler: worker/src/index.ts (~line 930)
Database:
  deleteArticleById(env, id)
  or blockArticleByIdAndDelete(env, id, reason) if blocking

--------------------------------------------------

POST /api/admin/article/update-datetime

Changes the published date and time for an article.

Input:
{
  "id": number,
  "publishedAt": string     — ISO 8601 timestamp
}

Handler: worker/src/index.ts (~line 758)
Database: updateArticlePublishedAt(env, id, isoString)

--------------------------------------------------

POST /api/admin/article/update-content

Edits the title, summary, and/or image URL of an article.

Input:
{
  "id": number,
  "title": string,          — optional
  "summary": string,        — optional
  "imageUrl": string | null — optional — pass empty string or null to clear
}

Handler: worker/src/index.ts (~line 819)
Database: updateArticleContent(env, id, { title, summary, imageUrl })

--------------------------------------------------

POST /api/admin/article/update-links

Updates the canonical URL and/or source URL for an article.
Performs a duplicate URL check before saving.

Input:
{
  "id": number,
  "canonicalUrl": string,   — optional
  "sourceUrl": string       — optional
}

Handler: worker/src/index.ts (~line 886)
Database: updateArticleLinks(env, id, { canonicalUrl, sourceUrl, urlHash })

--------------------------------------------------

OTHER ADMIN ENDPOINTS

Additional endpoints exist for listing articles, blocked items, metrics,
reclassification, ingestion, and backfill operations.

To find them: search for /api/admin/ in worker/src/index.ts.

--------------------------------------------------

DATABASE ACCESS PATTERN

Engine: Cloudflare D1 (SQLite)
All queries go through helpers in worker/src/lib/db.ts.
Never write raw queries inline in a route handler.

Use .run() when the query does not return rows:
  env.DB.prepare(query).bind(values).run()

Use .first() when expecting one row:
  env.DB.prepare(query).bind(values).first()

Use .all() when expecting multiple rows:
  env.DB.prepare(query).bind(values).all()

Never interpolate values directly into query strings.
Always use .bind() to pass parameters.

--------------------------------------------------

ADDING A NEW ENDPOINT

Before adding a new endpoint:

1. Search this index and worker/src/index.ts to confirm it does not already exist.
2. Follow the existing route structure in index.ts.
3. Add the database helper to worker/src/lib/db.ts — do not write inline queries.
4. Add the frontend call to src/services/siteService.js.
5. If it is an admin route, call isAdminAuthorized() before any database operation.
6. Respond only with json() or badRequest().
7. Add the new endpoint to this index file.

--------------------------------------------------

DEBUGGING INSTRUCTIONS

When an endpoint fails:

1. Find the endpoint in this index — note the handler file and line range.
2. Open that section of worker/src/index.ts.
3. Trace execution: auth check → validation → database call → response.
4. Identify the exact failing line or missing logic.
5. Apply the smallest safe fix confined to that handler.
6. Do not touch unrelated endpoints or shared utilities unless the fix requires it.
