# AI PROJECT MAP

This document describes the physical structure of the project so AI assistants can locate files, understand how they connect, and make changes safely.

Read AI_PROJECT_MEMORY.md for rules and patterns.
Read AI_ENDPOINT_INDEX.md for endpoint locations and expected inputs.

--------------------------------------------------

PROJECT TYPE

Kentucky-focused news website.

Backend: Cloudflare Workers API (TypeScript)
Frontend: React (JavaScript) with @material-ui/core v4
Database: Cloudflare D1 (SQLite)
Deployment: Wrangler

--------------------------------------------------

FOLDER STRUCTURE

worker/
  src/
    index.ts              — All API routes and the main fetch handler
    types.ts              — Shared TypeScript types
    lib/
      db.ts               — Database query helpers
      http.ts             — Response helpers: json(), badRequest()
      facebook.ts         — Facebook caption generation

src/
  pages/
    admin-page.js         — Admin dashboard (all tabs)
  services/
    siteService.js        — Frontend functions that call the API

.github/
  copilot-instructions.md         — AI task router (start here)
  instructions/
    fix-and-improve.md            — Loaded for bug fixes and improvements
    create.md                     — Loaded for new features

AI_PROJECT_MEMORY.md      — Architecture rules and patterns
AI_PROJECT_MAP.md         — This file
AI_ENDPOINT_INDEX.md      — Full endpoint list with handler locations

--------------------------------------------------

REQUEST FLOW

Every API request enters through the single fetch handler in worker/src/index.ts.

request
→ worker/src/index.ts (fetch handler)
→ path detection (if/else or regex match)
→ isAdminAuthorized() check (admin routes only)
→ validation (required fields present)
→ database helper in worker/src/lib/db.ts
→ json() or badRequest() from worker/src/lib/http.ts
→ response returned to client

--------------------------------------------------

BACKEND FILE RESPONSIBILITIES

worker/src/index.ts
  Contains every route handler.
  This is always the first file to check when debugging an endpoint.
  Admin routes call isAdminAuthorized() before touching the database.

worker/src/lib/db.ts
  Contains all database query functions.
  Handlers call these functions rather than writing raw queries inline.
  All queries use prepare().bind().run() / .first() / .all()

worker/src/lib/http.ts
  Contains json() and badRequest().
  Every API response must go through one of these two functions.
  Never construct a raw Response manually.

worker/src/lib/facebook.ts
  Generates captions for Facebook sharing.
  Only relevant to article publishing features.

worker/src/types.ts
  Shared TypeScript types used across the backend.
  Check here before adding new types.

--------------------------------------------------

FRONTEND FILE RESPONSIBILITIES

src/services/siteService.js
  All frontend API calls live here.
  When adding a new endpoint, add the corresponding frontend call here.
  Follows a consistent fetch pattern — copy existing functions when adding new ones.

src/pages/admin-page.js
  The admin dashboard.
  Organized into tabs (see tab map below).
  UI changes to admin features happen here.

--------------------------------------------------

ADMIN TAB MAP

Tab 0 — Dashboard
Tab 1 — Create Article
Tab 2 — Articles
Tab 3 — Blocked

When the user describes a problem on a specific admin tab, map it to this list
to identify the correct section of admin-page.js.

--------------------------------------------------

HOW THE BACKEND AND FRONTEND CONNECT

Frontend (src/services/siteService.js)
  calls →
Backend (worker/src/index.ts route handler)
  calls →
Database helper (worker/src/lib/db.ts)
  returns →
Handler responds with json() or badRequest()
  returns →
Frontend receives response and updates UI

When tracing a bug, start at the frontend call in siteService.js,
find the matching route in index.ts, then follow into db.ts if needed.

--------------------------------------------------

WHERE TO LOOK FOR COMMON PROBLEMS

Problem: endpoint returns wrong data or crashes
→ Start in worker/src/index.ts at the matching route handler

Problem: database query returns wrong results or fails
→ Check the helper function in worker/src/lib/db.ts

Problem: admin UI not showing correct data or button not working
→ Check src/pages/admin-page.js for the relevant tab

Problem: frontend API call failing or sending wrong data
→ Check src/services/siteService.js for the matching function

Problem: response format is wrong or missing fields
→ Check worker/src/lib/http.ts and the handler's json() call

--------------------------------------------------

AI RESPONSIBILITIES

When working in this project:

• Read AI_PROJECT_MEMORY.md for rules before making any change
• Read AI_ENDPOINT_INDEX.md to locate the correct handler before editing
• Use the folder structure and connection map above to find files quickly
• Never modify files outside the confirmed path for the fix or feature
• Preserve the existing routing style and architecture at all times
