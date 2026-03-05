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
Language: JavaScript  
Database: Cloudflare D1 (SQLite)

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

Admin endpoints require authorization before performing database operations.

--------------------------------------------------

DATABASE PATTERN

Database engine: Cloudflare D1.

Typical query pattern:

env.DB.prepare(query)
  .bind(parameters)
  .run()

or

env.DB.prepare(query)
  .bind(parameters)
  .first()

--------------------------------------------------

PROJECT RULES

When modifying the system:

• preserve the current routing architecture
• do not introduce new frameworks
• maintain the fetch handler pattern
• ensure endpoints return proper JSON responses
• avoid modifying shared utilities unless necessary

--------------------------------------------------

FEATURE IMPLEMENTATION GUIDELINES

New features should:

• follow existing endpoint structure
• reuse existing validation patterns
• reuse database helpers where possible
• avoid duplicating logic

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

AI DEVELOPMENT PHILOSOPHY

AI agents should behave like careful production engineers:

• investigate before modifying code
• avoid unnecessary refactoring
• preserve system stability
• prefer minimal safe changes