# GitHub Copilot Instructions — Kentucky News Project

Save as: `.github/copilot-instructions.md`

---

# YOU MUST FOLLOW THIS FILE EXACTLY

Do not summarize these instructions.
Do not skip phases.
Do not proceed past a phase until it is fully complete.
Do not make any edits without user confirmation.
If any rule is violated → print BLOCKED and stop immediately.

---

# GLOBAL RULES (ALWAYS APPLY)

1.  Never guess. Always read real code before diagnosing or building.
2.  Never change files not listed in the plan.
3.  Never refactor unrelated code.
4.  Never rename existing variables.
5.  Never add dependencies or install packages.
6.  Never run terminal commands during diagnosis, planning, or building.
7.  Never explore the entire repository.
8.  Never implement extra improvements.
9.  Never answer your own clarifying questions. Ask the user and wait.
10. If uncertain at any point → print BLOCKED and ask the user.

---

# BEFORE ANY TASK — READ THESE FILES FIRST

Read all three before doing anything else.

1. `AI_PROJECT_MEMORY.md`
2. `AI_PROJECT_MAP.md`
3. `AI_ENDPOINT_INDEX.md`

---

# STEP 1 — CLASSIFY THE REQUEST

Determine which type this is and print this block before doing anything else.

    ═══════════════════════════════════════════
    TASK CLASSIFICATION
    ═══════════════════════════════════════════
    TYPE:         [QUESTION | BUG FIX | IMPROVEMENT | NEW FEATURE]
    DESCRIPTION:  [one sentence]
    MODE:         [FIX MODE | CREATE MODE | QUESTION — no phases]
    ═══════════════════════════════════════════

Then follow the correct section below.

QUESTION        → Answer in plain English. Stop. Do not run any phases.
BUG FIX         → Follow FIX MODE below.
IMPROVEMENT     → Follow FIX MODE below.
NEW FEATURE     → Follow CREATE MODE below.

---
---

# FIX MODE
# For: BUG FIX and IMPROVEMENT

Limits:
  Maximum files to read:    4
  Maximum files to change:  2
  Maximum edits:            3

---

## FIX — PHASE 1 — INTAKE

Print and fill this block completely before moving on.

    ═══════════════════════════════════════════
    FIX PHASE 1 — INTAKE
    ═══════════════════════════════════════════
    REQUEST TYPE:       [BUG FIX | IMPROVEMENT]
    AREA AFFECTED:      [exact page, tab, file, or endpoint]
    WHAT HAPPENS NOW:   [current behavior]
    WHAT SHOULD HAPPEN: [expected behavior]
    ERROR MESSAGE:      [exact text or N/A]
    ═══════════════════════════════════════════

Do not move to Phase 2 until this block is printed.

---

## FIX — PHASE 2 — DIAGNOSE

Read relevant files. Maximum 4.

After reading each file, stop and ask yourself:

  Do I now know the exact broken line or missing logic?

If YES → print the DIAGNOSE block and move to Phase 3.
If NO after 4 files → print the BLOCKED block and stop.

---

DIAGNOSE BLOCK:

    ═══════════════════════════════════════════
    FIX PHASE 2 — DIAGNOSE
    ═══════════════════════════════════════════
    FILES READ:
      [filename, lines]: [one sentence summary]
      [filename, lines]: [one sentence summary]

    CONFIRMED ROOT CAUSE:
      File:     [exact filename]
      Location: [function name or line number]
      Cause:    [what is wrong and exactly why]

    EXISTING CODE TO REUSE:
      [existing logic already in the codebase]

    WHAT NEEDS TO CHANGE:
      • [specific change]
      • [specific change]
    ═══════════════════════════════════════════

---

BLOCKED BLOCK:

    ═══════════════════════════════════════════
    FIX PHASE 2 — BLOCKED: NEED MORE INFORMATION
    ═══════════════════════════════════════════
    Files read: [N]

    What I found:
    [short explanation]

    What is still unclear:
    [one sentence]

    My question for you:
    [one specific question — wait for answer before continuing]
    ═══════════════════════════════════════════

STOP. Do not continue until the user replies.

---

## FIX — PHASE 3 — PLAN

No code in this phase.

Before writing the plan, check:

  • Does this require more than 2 files?
  • Does this require more than 3 edits?
  • Is the change unsafe or unclear?

If YES to any → print SCOPE BLOCK and stop.

---

SCOPE BLOCK:

    ═══════════════════════════════════════════
    FIX PHASE 3 — BLOCKED: TASK TOO LARGE
    ═══════════════════════════════════════════
    This fix requires:
      Files: [N]
      Edits: [N]

    Maximum allowed: 2 files / 3 edits

    Suggested split:
      Task A: [description]
      Task B: [description]

    Please start a new chat for each task.
    ═══════════════════════════════════════════

STOP.

---

PLAN BLOCK:

    ═══════════════════════════════════════════
    FIX PHASE 3 — PLAN
    ═══════════════════════════════════════════
    CHANGE TYPE:  [BUG FIX | IMPROVEMENT]
    SCOPE:        [BACKEND | FRONTEND | BOTH]

    FILES CHANGING:
      1. [filename] — [what changes]
      2. [filename] — [what changes]

    FILES NOT TOUCHING:
      [list every file that will not be changed]

    EDITS:
      Edit 1: [filename] — [function or line] — [exact change]
      Edit 2: [filename] — [function or line] — [exact change]
      Edit 3: [filename] — [function or line] — [exact change]

    RISK CHECK:
      Breaks existing feature?        [Yes — explain | No]
      New admin route needs auth?     [Yes — will call isAdminAuthorized() | N/A]
      Null crash possible?            [describe guard | N/A]
    ═══════════════════════════════════════════

Do not move to Phase 4 until this block is printed.

---

## FIX — PHASE 4 — BUILD

Print this header first:

    ═══════════════════════════════════════════
    FIX PHASE 4 — BUILD
    ═══════════════════════════════════════════

Then print this confirmation block and STOP. Do not make any edits yet.

    ═══════════════════════════════════════════
    READY TO EDIT — WAITING FOR CONFIRMATION
    ═══════════════════════════════════════════
    I am about to make these changes:

      Edit 1: [filename] — [exact change]
      Edit 2: [filename] — [exact change]
      Edit 3: [filename] — [exact change]

    Type YES to continue or tell me to stop.
    ═══════════════════════════════════════════

Wait for the user to type YES. Do not proceed without it.

Once confirmed, for each edit:
  1. Find the exact function or line.
  2. Change only the planned code.
  3. Do not touch surrounding logic.
  4. Save the file.
  5. Print: Edit [N] of [Total] — [filename] — APPLIED ✓
     Or:    Edit [N] of [Total] — [filename] — FAILED

If an edit fails → print this block and stop immediately:

    ═══════════════════════════════════════════
    FIX PHASE 4 — BLOCKED: EDIT FAILED
    ═══════════════════════════════════════════
    Failed edit: [number]
    Error: [exact error message]
    What I need from you: [specific ask]
    ═══════════════════════════════════════════

---

## FIX — PHASE 5 — REVIEW

    ═══════════════════════════════════════════
    FIX PHASE 5 — REVIEW
    ═══════════════════════════════════════════
    [✓/✗] Fix addresses the confirmed root cause
    [✓/✗] Error paths are handled
    [✓/✗] No .map/.filter/.forEach on undefined
    [✓/✗] Frontend loading state cleared in finally block
    [✓/✗] Admin routes call isAdminAuthorized()
    [✓/✗] DB queries use prepare()
    [✓/✗] API responses use json() or badRequest()
    [✓/✗] Only planned files were changed
    [✓/✗] No terminal commands used during editing
    [✓/✗] 3 or fewer edits across 2 or fewer files

    ISSUES: [list or None]

    RESULT: [PASS | FAIL]
    ═══════════════════════════════════════════

If FAIL → explain what failed and ask the user. Do not make more edits.

---

## FIX — PHASE 6 — DONE

    ═══════════════════════════════════════════
    FIX PHASE 6 — DONE
    ═══════════════════════════════════════════
    ✅ [What was accomplished in plain English]

    WHAT WAS WRONG:
    [one or two plain English sentences]

    WHAT WAS FIXED:
    • [outcome]
    • [outcome]

    HOW TO TEST:
    1. [UI step]
    2. [UI step]
    3. [expected result]

    DEPLOY REQUIRED?

    YES — run this in your terminal:
      npx wrangler deploy

    If something looks wrong after deploying, run this to undo it:
      npx wrangler rollback

    NO — no action needed

    FILES CHANGED:
    • [filename]
    ═══════════════════════════════════════════

---
---

# CREATE MODE
# For: NEW FEATURE

Limits:
  Maximum files to read:    4
  Maximum files to change:  3
  Maximum edits:            5

---

## CREATE — PHASE 1 — INTAKE

Print and fill this block completely before moving on.

    ═══════════════════════════════════════════
    CREATE PHASE 1 — INTAKE
    ═══════════════════════════════════════════
    WHAT TO BUILD:      [plain English description]
    WHERE IT LIVES:     [page, tab, endpoint, or component]
    WHO USES IT:        [admin only | public | both]
    INPUTS:             [what the user provides]
    OUTPUT / RESULT:    [what happens when it works]
    ═══════════════════════════════════════════

Do not move to Phase 2 until this block is printed.

---

## CREATE — PHASE 2 — DOES IT ALREADY EXIST?

Before building anything, confirm this feature is not already in the codebase.

Read relevant files. Maximum 4.

After reading each file, stop and ask yourself:

  Does this feature or something close to it already exist?

If YES → print EXISTS block and stop.
If NO after checking → print READY block and move to Phase 3.

---

EXISTS BLOCK:

    ═══════════════════════════════════════════
    CREATE PHASE 2 — ALREADY EXISTS
    ═══════════════════════════════════════════
    Found:
      File:         [filename]
      Location:     [function or line]
      What it does: [one sentence]

    This is the same as — or very close to — what you asked for.

    Options:
      A) Use what is already there
      B) Extend it — start a new chat and describe it as an IMPROVEMENT
      C) Replace it — tell me why the existing version will not work

    Which would you like to do?
    ═══════════════════════════════════════════

STOP. Wait for the user to reply.

---

READY BLOCK:

    ═══════════════════════════════════════════
    CREATE PHASE 2 — CONFIRMED: DOES NOT EXIST
    ═══════════════════════════════════════════
    Files read: [N]
    Confirmed: this feature is not in the codebase.

    Existing patterns I will follow:
      • [pattern or convention found in codebase]
      • [pattern or convention found in codebase]
    ═══════════════════════════════════════════

---

## CREATE — PHASE 3 — PLAN

No code in this phase.

Before writing the plan, check:

  • Does this require more than 3 files?
  • Does this require more than 5 edits?
  • Does it touch auth, payments, or the database schema?
  • Is anything unclear or unsafe?

If YES to any → print SCOPE BLOCK and stop.

---

SCOPE BLOCK:

    ═══════════════════════════════════════════
    CREATE PHASE 3 — BLOCKED: TASK TOO LARGE
    ═══════════════════════════════════════════
    This build requires:
      Files: [N]
      Edits: [N]

    Maximum allowed: 3 files / 5 edits

    Reason: [one sentence]

    Suggested split:
      Task A: [description — do this first]
      Task B: [description — do this after A works]

    Please start a new chat for each task.
    ═══════════════════════════════════════════

STOP.

---

PLAN BLOCK:

    ═══════════════════════════════════════════
    CREATE PHASE 3 — PLAN
    ═══════════════════════════════════════════
    WHAT IS BEING BUILT:  [plain English]
    SCOPE:                [BACKEND | FRONTEND | BOTH]

    FILES CHANGING:
      1. [filename] — [what gets added]
      2. [filename] — [what gets added]
      3. [filename] — [what gets added]

    FILES NOT TOUCHING:
      [list every file that will not be changed]

    EDITS:
      Edit 1: [filename] — [location] — [what will be added]
      Edit 2: [filename] — [location] — [what will be added]
      Edit 3: [filename] — [location] — [what will be added]
      Edit 4: [filename] — [location] — [what will be added]
      Edit 5: [filename] — [location] — [what will be added]

    PATTERNS FOLLOWED:
      • [existing convention this new code copies]
      • [existing convention this new code copies]

    RISK CHECK:
      Could break existing feature?   [Yes — explain | No]
      New admin route needs auth?     [Yes — will call isAdminAuthorized() | N/A]
      New DB column needed?           [Yes — name and type | No]
      Null crash possible?            [describe guard | N/A]
    ═══════════════════════════════════════════

Do not move to Phase 4 until this block is printed.

---

## CREATE — PHASE 4 — BUILD

Print this header first:

    ═══════════════════════════════════════════
    CREATE PHASE 4 — BUILD
    ═══════════════════════════════════════════

Then print this confirmation block and STOP. Do not make any edits yet.

    ═══════════════════════════════════════════
    READY TO BUILD — WAITING FOR CONFIRMATION
    ═══════════════════════════════════════════
    I am about to add the following:

      Edit 1: [filename] — [exact change]
      Edit 2: [filename] — [exact change]
      Edit 3: [filename] — [exact change]
      Edit 4: [filename] — [exact change]
      Edit 5: [filename] — [exact change]

    Type YES to continue or tell me to stop.
    ═══════════════════════════════════════════

Wait for the user to type YES. Do not proceed without it.

Once confirmed, for each edit:
  1. Find the exact insertion point.
  2. Add only the planned code.
  3. Match the style of the surrounding code exactly.
  4. Do not modify existing logic nearby.
  5. Save the file.
  6. Print: Edit [N] of [Total] — [filename] — APPLIED ✓
     Or:    Edit [N] of [Total] — [filename] — FAILED

If an edit fails → print this block and stop immediately:

    ═══════════════════════════════════════════
    CREATE PHASE 4 — BLOCKED: EDIT FAILED
    ═══════════════════════════════════════════
    Failed edit: [number]
    Error: [exact error message]
    What I need from you: [specific ask]
    ═══════════════════════════════════════════

---

## CREATE — PHASE 5 — REVIEW

    ═══════════════════════════════════════════
    CREATE PHASE 5 — REVIEW
    ═══════════════════════════════════════════
    [✓/✗] Feature matches what was described in Phase 1
    [✓/✗] Follows existing code patterns and style
    [✓/✗] Did not modify code outside the plan
    [✓/✗] Error paths are handled
    [✓/✗] No .map/.filter/.forEach on undefined
    [✓/✗] Frontend loading state cleared in finally block
    [✓/✗] New admin route calls isAdminAuthorized()
    [✓/✗] DB queries use prepare()
    [✓/✗] API responses use json() or badRequest()
    [✓/✗] New DB columns accounted for in queries
    [✓/✗] No terminal commands used during build
    [✓/✗] 5 or fewer edits across 3 or fewer files

    ISSUES: [list or None]

    RESULT: [PASS | FAIL]
    ═══════════════════════════════════════════

If FAIL → explain what failed and ask the user. Do not make more edits.

---

## CREATE — PHASE 6 — DONE

    ═══════════════════════════════════════════
    CREATE PHASE 6 — DONE
    ═══════════════════════════════════════════
    ✅ [What was built in plain English]

    WHAT IT DOES:
    [one or two sentences a non-developer can understand]

    HOW TO TEST:
    1. [UI step]
    2. [UI step]
    3. [expected result]

    IF SOMETHING LOOKS WRONG:
    The new code is in [filename]. Nothing else was changed.
    To undo: remove the lines that were added in that file.

    DEPLOY REQUIRED?

    YES — run this in your terminal:
      npx wrangler deploy

    If something looks wrong after deploying, run this to undo it:
      npx wrangler rollback

    NO — no action needed

    FILES CHANGED:
    • [filename]
    ═══════════════════════════════════════════
