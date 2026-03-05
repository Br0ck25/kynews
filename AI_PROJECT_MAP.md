# AI PROJECT MAP

This document describes the architecture of the project so AI assistants can debug and modify the code safely.

--------------------------------------------------

PROJECT TYPE

News website backend API.

Provides endpoints for:

• article ingestion
• article tagging
• admin operations
• content retrieval

--------------------------------------------------

RUNTIME ENVIRONMENT

Runtime: Cloudflare Workers  
Language: JavaScript  
Database: Cloudflare D1 (SQLite)

API style: fetch handler routing

--------------------------------------------------

REQUEST FLOW

All requests enter through the main fetch handler.

Typical flow:

request
→ router / path detection
→ endpoint handler
→ validation
→ database operation
→ JSON response

--------------------------------------------------

API STRUCTURE

Endpoints follow this structure:

/api/*
    public endpoints

/api/admin/*
    admin-only endpoints

Examples:

POST /api/admin/retag
POST /api/admin/delete
GET /api/articles
GET /api/article/:id

--------------------------------------------------

DATABASE

Database engine: Cloudflare D1 (SQLite)

Typical operations:

• selecting articles
• inserting articles
• updating tags
• deleting content
• storing ingestion data

Queries are executed using env.DB.

Example pattern:

env.DB.prepare(query).bind(values).run()

--------------------------------------------------

COMMON SYSTEM COMPONENTS

Router  
Handles request path detection.

Endpoint Handlers  
Process API requests.

Validation  
Ensures required parameters exist.

Database Layer  
Runs D1 queries.

Response Layer  
Returns JSON responses.

--------------------------------------------------

ADMIN SYSTEM

Admin endpoints require authorization.

Common admin tasks include:

• retagging articles
• deleting articles
• updating metadata

Admin endpoints typically validate credentials before running database updates.

--------------------------------------------------

DEBUGGING NOTES FOR AI

When debugging:

1. Locate the endpoint handling the request.
2. Trace the request flow from router → handler → database query.
3. Identify where the error occurs.
4. Apply the smallest safe fix.

Avoid changing unrelated endpoints.

Preserve the existing architecture.

--------------------------------------------------

AI RESPONSIBILITIES

When modifying this project:

• search the repository before proposing fixes
• simulate request execution
• identify the failing line
• implement the smallest safe patch
• ensure changes do not break other endpoints