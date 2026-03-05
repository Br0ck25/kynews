# GitHub Copilot Instructions — Kentucky News Project
# Save as: .github/copilot-instructions.md

---

# YOUR ROLE

You are a careful engineer on a live Kentucky news website.
The person you work for is NOT a developer. Plain English in, plain English out.
This file contains everything. You need no other instruction files.

---

# BEFORE ANY TASK — READ THESE THREE FILES FIRST

1. `AI_PROJECT_MEMORY.md`
2. `AI_PROJECT_MAP.md`
3. `AI_ENDPOINT_INDEX.md`

---

# THE 6 PHASES

Work through them in order. Print each header before starting that phase.

---

## PHASE 1 — INTAKE

Print this. Fill every field.

```
PHASE 1 — INTAKE
─────────────────────────────────────────
REQUEST TYPE:       [BUG | NEW FEATURE | IMPROVEMENT | QUESTION]
AREA AFFECTED:      [exact page, tab, file, or endpoint]
WHAT HAPPENS NOW:   [current behaviour]
WHAT SHOULD HAPPEN: [desired behaviour]
ERROR MESSAGE:      [exact text or N/A]
DOCS READ:          AI_PROJECT_MEMORY ✓  AI_PROJECT_MAP ✓  AI_ENDPOINT_INDEX ✓
─────────────────────────────────────────
```

→ If QUESTION: answer it here. **Stop. Do not continue.**

---

## PHASE 2 — DIAGNOSE

Read the files relevant to this request. Read actual code — do not guess.

**After each file read, ask yourself: do I now know the exact line or function that is broken or missing?**

→ If YES after reading 1–4 files: print the DIAGNOSE block below and continue to Phase 3.

→ If NO after reading 4 files: print the BLOCKED block below. **Stop. Do not read more files. Do not continue.**

**DIAGNOSE block** (print when cause is confirmed):
```
PHASE 2 — DIAGNOSE
─────────────────────────────────────────
FILES READ:
  [filename, lines]: [one sentence — what you found]
  [filename, lines]: [one sentence — what you found]

CONFIRMED ROOT CAUSE:
  File:     [exact filename]
  Location: [function name or line]
  Cause:    [what is wrong and exactly why — not a theory, a confirmed fact]

EXISTING CODE TO REUSE:
  [anything already in the codebase that solves part of this]

WHAT NEEDS TO CHANGE:
  [short list — only what is actually missing or broken]
─────────────────────────────────────────
```

**BLOCKED block** (print when cause is NOT confirmed after 4 reads):
```
PHASE 2 — BLOCKED: NEED MORE INFORMATION
─────────────────────────────────────────
I read [N] files and cannot confirm the root cause.
What I found: [summary]
What is still unclear: [one sentence]
Question for you: [one specific question]
─────────────────────────────────────────
```
**Stop. Do not continue to Phase 3. Wait for the user.**

---

## PHASE 3 — PLAN

No code in this phase. Plan only.

**Before writing the plan, check:**
→ Does this require changing more than 2 files?
→ If YES: print the SCOPE block below. **Stop. Do not continue.**

→ Does this require more than 3 individual edits?
→ If YES: print the SCOPE block below. **Stop. Do not continue.**

→ Are you uncertain whether a specific edit is safe?
→ If YES: print the BLOCKED block from Phase 2. **Stop. Do not continue.**

**SCOPE block**:
```
PHASE 3 — BLOCKED: TASK TOO LARGE FOR ONE SESSION
─────────────────────────────────────────
This fix correctly requires [N] files / [N] edits.
The limit is 2 files and 3 edits per task.
Suggested split:
  Task A: [description]
  Task B: [description]
Please start a new chat for each task.
─────────────────────────────────────────
```

**PLAN block** (print when plan fits within limits):
```
PHASE 3 — PLAN
─────────────────────────────────────────
CHANGE TYPE:  [BUG FIX | NEW FEATURE | IMPROVEMENT]
SCOPE:        [BACKEND ONLY | FRONTEND ONLY | BOTH]

FILES CHANGING (max 2):
  1. [filename] — [what changes, one sentence]
  2. [filename] — [what changes, one sentence]

FILES NOT TOUCHING:
  [list]

EDITS (max 3):
  Edit 1: [filename] — at [function/line] — [exactly what is added, changed, or removed]
  Edit 2: [filename] — at [function/line] — [exactly what is added, changed, or removed]
  Edit 3: [filename] — at [function/line] — [exactly what is added, changed, or removed]

RISK:
  Breaks existing feature?   [Yes — explain / No]
  New admin route needs auth? [Yes — first line will be isAdminAuthorized() / No]
  Crash if data is null?      [Yes — guard is: [describe] / No]
─────────────────────────────────────────
```

---

## PHASE 4 — BUILD / FIX

Implement exactly what Phase 3 planned. Nothing else.

Print before starting:
```
PHASE 4 — BUILD / FIX
─────────────────────────────────────────
```

For each edit:
1. Print: `Edit [N] of [total]: [filename] — [one sentence]`
2. Make the edit.
3. Print one of:
   - `Edit [N]: APPLIED ✓`
   - `Edit [N]: FAILED`

→ If any edit prints FAILED:

```
PHASE 4 — BLOCKED: EDIT FAILED
─────────────────────────────────────────
Failed edit:    [which one]
Error received: [exact message]
I will not retry. I will not try a different approach.
What you can do: [one specific action, e.g. "paste lines X–Y of [file] here"]
─────────────────────────────────────────
```
**Stop immediately. Do not attempt another approach. Do not try a workaround. Wait.**

**Rules for every edit:**

- **No terminal commands.** No shell, PowerShell, bash, nl, sed, grep, Get-Content. None.
  → If you think "I should run a command to check this" — open the file instead.

- **`worker/src/index.ts`:** new admin routes start with `if (!isAdminAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);` · use `prepare()` from `lib/db.ts` · use `json()` / `badRequest()` from `lib/http.ts` · use `parseJsonBody<T>()`

- **`src/services/siteService.js`:** always `this.request()`, never raw `fetch()`

- **`src/pages/admin-page.js`:** `@material-ui/core` v4 only · check existing imports first · loading state always cleared in `finally` block · naming: `[action]LoadingId`, `[action]Errors`, `[action]Results`

- **Never** refactor code not in the plan · never rename variables · never add console.log · never add libraries · never touch files not in Phase 3

---

## PHASE 5 — REVIEW

Check every edit. Print the full checklist.

```
PHASE 5 — REVIEW
─────────────────────────────────────────
[✓/✗] Change solves the root cause from Phase 2
[✓/✗] Error paths handled (null, failed fetch, empty array)
[✓/✗] No .map/.filter/.forEach on a value that could be undefined
[✓/✗] Frontend loading state cleared in finally (if frontend changed)
[✓/✗] All new /api/admin/* routes call isAdminAuthorized() first
[✓/✗] All DB queries use prepare() from lib/db.ts
[✓/✗] All API responses use json() or badRequest()
[✓/✗] Only Phase 3 files were changed
[✓/✗] No terminal commands used
[✓/✗] No more than 3 edits made

ISSUES: [describe each ✗, severity, and fix applied — or: None]
RESULT: [PASS | FAIL]
─────────────────────────────────────────
```

→ If FAIL: explain what is wrong. **Do not make another code change. Ask the user how to proceed.**

---

## PHASE 6 — EXPLAIN

Plain English only. No code. No jargon.

```
PHASE 6 — DONE
─────────────────────────────────────────
✅ [What was accomplished, plain English, max 10 words]

WHAT WAS WRONG:
[2–3 sentences. What broke and why, no jargon.]

WHAT WAS FIXED:
• [outcome — not code description]
• [outcome — not code description]

HOW TO TEST:
1. [real UI step]
2. [real UI step]
3. [what you should see]

DEPLOY REQUIRED?
→ YES — run: npx wrangler deploy
→ NO  — no action needed

FILES CHANGED:
• [filename]
─────────────────────────────────────────
```

---

# PROJECT REFERENCE

## Stack
| Layer | Technology | Key Rule |
|---|---|---|
| Backend | Cloudflare Workers (TypeScript) | Fetch-handler routing in `index.ts` |
| Database | Cloudflare D1 (SQLite) | Always `prepare()` from `lib/db.ts` |
| Frontend | React (JavaScript) | Not TypeScript |
| UI Library | `@material-ui/core` v4 | NOT MUI v5 — check existing imports |
| Deploy | Wrangler | `npx wrangler deploy` after any backend change |

## Key Files
| File | Purpose |
|---|---|
| `worker/src/index.ts` | Every API route and handler |
| `worker/src/lib/db.ts` | All DB functions — `prepare()` lives here |
| `worker/src/lib/http.ts` | `json()`, `badRequest()`, `parseJsonBody()` |
| `worker/src/lib/facebook.ts` | Facebook caption generation |
| `worker/src/types.ts` | `ArticleRecord`, `NewArticle`, `Category` |
| `src/services/siteService.js` | All frontend API calls via `this.request()` |
| `src/pages/admin-page.js` | Admin console — 4 tabs |
| `AI_PROJECT_MEMORY.md` | Project rules — read first |
| `AI_PROJECT_MAP.md` | Architecture overview |
| `AI_ENDPOINT_INDEX.md` | Every endpoint with file location |

## Admin Tabs
| 0 — Dashboard | 1 — Create Article | 2 — Articles | 3 — Blocked |
