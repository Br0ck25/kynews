# Create Instructions — Kentucky News Project

Save as: `.github/instructions/create.md`

Loaded by `.github/copilot-instructions.md` for NEW FEATURE tasks.

---

# LIMITS FOR THIS FILE

Maximum files you may read: **4**
Maximum files you may change: **3**
Maximum edits: **5**

---

# THE 6 PHASES

Work through the phases in order.
Always print the phase header before starting.

---

# PHASE 1 — INTAKE

Print and fill this block.

    PHASE 1 — INTAKE
    ─────────────────────────────────────────
    WHAT TO BUILD:      [plain English description]
    WHERE IT LIVES:     [page, tab, endpoint, or component]
    WHO USES IT:        [admin only | public | both]
    INPUTS:             [what the user provides]
    OUTPUT / RESULT:    [what happens when it works]
    ─────────────────────────────────────────

---

# PHASE 2 — DOES IT ALREADY EXIST?

Before building anything, confirm the feature is not already in the codebase.

Read relevant files. Maximum **4**.

After each file read ask:

> Does this feature or something close to it already exist?

If it exists → print EXISTS block and stop.
If it does not exist → print READY block and continue.

---

### EXISTS BLOCK

    PHASE 2 — ALREADY EXISTS
    ─────────────────────────────────────────
    Found:
      File:         [filename]
      Location:     [function or line]
      What it does: [one sentence]

    This is the same as — or very close to — what you asked for.

    Options:
    A) Use what is already there
    B) Extend it (start a new chat, use IMPROVEMENT type)
    C) Replace it (explain why the existing version will not work)

    Which would you like to do?
    ─────────────────────────────────────────

STOP.

---

### READY BLOCK

    PHASE 2 — CONFIRMED: DOES NOT EXIST
    ─────────────────────────────────────────
    Files read: [N]

    Confirmed: this feature is not in the codebase.

    Existing patterns I will follow:
    • [pattern or convention found in codebase]
    • [pattern or convention found in codebase]
    ─────────────────────────────────────────

---

# PHASE 3 — PLAN

No code in this phase.

Before planning check:

• More than **3 files** required?
• More than **5 edits** required?
• Touches auth, payments, or the database schema?
• Unsure if the change is safe?

If YES to any → print SCOPE block and stop.

---

### SCOPE BLOCK

    PHASE 3 — BLOCKED: TASK TOO LARGE
    ─────────────────────────────────────────
    This build requires:

    Files: [N]
    Edits: [N]

    Maximum allowed:
    3 files / 5 edits

    Reason this is too large:
    [one sentence]

    Suggested split:

    Task A: [description — start here]
    Task B: [description — do after A is working]

    Please open a new chat for each task.
    ─────────────────────────────────────────

---

### PLAN BLOCK

    PHASE 3 — PLAN
    ─────────────────────────────────────────
    WHAT IS BEING BUILT:  [plain English]
    SCOPE:                [BACKEND | FRONTEND | BOTH]

    FILES CHANGING:
    1. [filename] — [what gets added]
    2. [filename] — [what gets added]
    3. [filename] — [what gets added]

    FILES NOT TOUCHING:
    [list]

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
    Could break existing feature?       [Yes/No — explain if Yes]
    New admin route needs auth?         [Yes — will call isAdminAuthorized() | N/A]
    New DB column needed?               [Yes — name and type | No]
    Null crash possible?                [guard description or N/A]
    ─────────────────────────────────────────

---

# PHASE 4 — BUILD

Print header first.

    PHASE 4 — BUILD
    ─────────────────────────────────────────

Before making any edits, print this confirmation block and stop.

    READY TO BUILD
    ─────────────────────────────────────────
    I am about to add the following:

    Edit 1: [filename] — [what exactly will be added]
    Edit 2: [filename] — [what exactly will be added]
    Edit 3: [filename] — [what exactly will be added]

    Type YES to continue, or tell me to stop.
    ─────────────────────────────────────────

Wait for the user to confirm before proceeding.

Once confirmed, for each edit:

1. Locate the exact insertion point.
2. Add only the planned code.
3. Follow the exact same style as surrounding code.
4. Do not modify existing logic nearby.
5. Save the file.

Print:

    Edit [N] of [Total] — [filename]
    Edit [N]: APPLIED ✓

OR

    Edit [N]: FAILED

---

### FAILED EDIT BLOCK

    PHASE 4 — BLOCKED: EDIT FAILED
    ─────────────────────────────────────────
    Failed edit: [number]

    Error received:
    [exact error]

    Next step needed from user:
    [paste code lines or explain]
    ─────────────────────────────────────────

STOP immediately.

---

# PHASE 5 — REVIEW

    PHASE 5 — REVIEW
    ─────────────────────────────────────────
    [✓/✗] Feature matches what was described in Phase 1
    [✓/✗] Follows existing code patterns and style
    [✓/✗] Did not modify code outside the plan
    [✓/✗] Error paths handled (missing data, failed fetch, etc.)
    [✓/✗] No .map/.filter/.forEach on undefined
    [✓/✗] Frontend loading state cleared in finally block
    [✓/✗] New admin route calls isAdminAuthorized()
    [✓/✗] DB queries use prepare()
    [✓/✗] API responses use json() or badRequest()
    [✓/✗] New DB columns accounted for in queries
    [✓/✗] No terminal commands used during build
    [✓/✗] ≤ 5 edits made across ≤ 3 files

    ISSUES:
    [list or None]

    RESULT:
    [PASS | FAIL]
    ─────────────────────────────────────────

If FAIL → explain and ask user. Do not make additional edits.

---

# PHASE 6 — EXPLAIN

    PHASE 6 — DONE
    ─────────────────────────────────────────
    ✅ [What was built]

    WHAT IT DOES:
    [one or two sentences a non-developer can understand]

    HOW TO TEST:
    1. [UI step]
    2. [UI step]
    3. [expected result]

    IF SOMETHING LOOKS WRONG:
    The new code is in [filename]. Nothing else was changed.
    You can undo by removing the lines added in that file.

    DEPLOY REQUIRED?

    YES — run this in your terminal:
    npx wrangler deploy

    If something looks wrong after deploying, you can undo it by running:
    npx wrangler rollback

    NO — no action needed

    FILES CHANGED:
    • [filename]
    ─────────────────────────────────────────
