# AI PROJECT MEMORY

This document stores important architectural knowledge and project rules.

All AI agents must read this document before performing work.

--------------------------------------------------

PROJECT PURPOSE

This project powers a Kentucky-focused news website.

The system provides:

• article ingestion
• article tagging
• county directories
• public news content
• admin content management

--------------------------------------------------

CORE ARCHITECTURE

Runtime: Cloudflare Workers
Backend language: TypeScript
Frontend language: JavaScript (React)
Frontend UI library: @material-ui/core v4
Database: Cloudflare D1 (SQLite)
Deployment tool: Wrangler

Routing style:
fetch handler with path detection.

Typical request flow:

request
→ router
→ endpoint handler
→ validation
→ business logic
→ database operation
→ JSON response

--------------------------------------------------

API STRUCTURE

Public endpoints:

/api/*

Admin endpoints:

/api/admin/*

Admin endpoints require authorization before performing any database operations.
Authorization is checked by calling isAdminAuthorized() at the start of every admin handler.
Never skip this call on admin routes.

--------------------------------------------------

RESPONSE PATTERN

All API responses must use the helpers in worker/src/lib/http.ts.

Success response:
json(data)

Error response:
badRequest(message)

Never construct raw Response objects manually.
Never return plain strings as API responses.

--------------------------------------------------

DATABASE PATTERN

Database engine: Cloudflare D1.

All queries must use prepare() with bound parameters.
Never interpolate values directly into query strings.

Use .run() when the query does not return rows:
env.DB.prepare(query).bind(parameters).run()

Use .first() when expecting a single row:
env.DB.prepare(query).bind(parameters).first()

Use .all() when expecting multiple rows:
env.DB.prepare(query).bind(parameters).all()

--------------------------------------------------

PROJECT RULES

When modifying the system:

• preserve the current routing architecture
• do not introduce new frameworks or dependencies
• maintain the fetch handler pattern
• ensure all endpoints use json() or badRequest() for responses
• avoid modifying shared utilities unless the fix requires it
• admin routes must always call isAdminAuthorized()

--------------------------------------------------

FEATURE IMPLEMENTATION GUIDELINES

New features should:

• follow existing endpoint structure
• reuse existing validation patterns
• reuse database helpers where possible
• avoid duplicating logic
• check that the feature does not already exist before building it

--------------------------------------------------

DEBUGGING GUIDELINES

When fixing bugs:

1. Locate the endpoint handling the request.
2. Trace the execution path.
3. Verify database queries and result handling.
4. Apply the smallest safe fix.

--------------------------------------------------

KNOWN SYSTEM AREAS

Major system components include:

• article ingestion
• tagging system
• admin endpoints
• county directory pages
• news article retrieval

--------------------------------------------------

KEY FILES

worker/src/index.ts         — API routes
worker/src/lib/db.ts        — DB helpers
worker/src/lib/http.ts      — Response helpers (json, badRequest)
worker/src/lib/facebook.ts  — Facebook captions
worker/src/types.ts         — Types
src/services/siteService.js — Frontend API service
src/pages/admin-page.js     — Admin dashboard

--------------------------------------------------

ADMIN TABS

Tab 0 — Dashboard
Tab 1 — Create Article
Tab 2 — Articles
Tab 3 — Blocked

--------------------------------------------------

AI DEVELOPMENT PHILOSOPHY

AI agents should behave like careful production engineers:

• investigate before modifying code
• avoid unnecessary refactoring
• preserve system stability
• prefer minimal safe changes
• never guess — read the actual code first
• stop and ask the user if anything is unclear
