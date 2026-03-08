# Fix & Improve Instructions — Kentucky News Project

Save as: `.github/instructions/fix-and-improve.md`

Loaded by `.github/copilot-instructions.md` for BUG FIX and IMPROVEMENT tasks.

---

# LIMITS FOR THIS FILE

Maximum files you may read: **4**
Maximum files you may change: **2**
Maximum edits: **3**

---

# THE 6 PHASES

Work through the phases in order.
Always print the phase header before starting.

---

# PHASE 1 — INTAKE

Print and fill this block.

    PHASE 1 — INTAKE
    ─────────────────────────────────────────
    REQUEST TYPE:       [BUG FIX | IMPROVEMENT]
    AREA AFFECTED:      [exact page, tab, file, endpoint]
    WHAT HAPPENS NOW:   [current behavior]
    WHAT SHOULD HAPPEN: [expected behavior]
    ERROR MESSAGE:      [exact text or N/A]
    ─────────────────────────────────────────

---

# PHASE 2 — DIAGNOSE

Read relevant files. Maximum **4**.

After each file read ask:

> Do I now know the exact broken line or missing logic?

If YES → print DIAGNOSE block.
If NO after 4 files → print BLOCKED block.

---

### DIAGNOSE BLOCK

    PHASE 2 — DIAGNOSE
    ─────────────────────────────────────────
    FILES READ:
      [filename, lines]: [one sentence summary]
      [filename, lines]: [one sentence summary]

    CONFIRMED ROOT CAUSE:
      File:     [exact filename]
      Location: [function name or line]
      Cause:    [what is wrong and exactly why]

    EXISTING CODE TO REUSE:
      [existing logic already in codebase]

    WHAT NEEDS TO CHANGE:
      • [specific change]
      • [specific change]
    ─────────────────────────────────────────

---

### BLOCKED BLOCK

    PHASE 2 — BLOCKED: NEED MORE INFORMATION
    ─────────────────────────────────────────
    Files read: [N]

    What I discovered:
    [short explanation]

    What is unclear:
    [one sentence]

    Question for you:
    [one specific question]
    ─────────────────────────────────────────

STOP.

---

# PHASE 3 — PLAN

No code in this phase.

Before planning check:

• More than **2 files** required?
• More than **3 edits** required?
• Unsure if the change is safe?

If YES → print SCOPE block and stop.

---

### SCOPE BLOCK

    PHASE 3 — BLOCKED: TASK TOO LARGE
    ─────────────────────────────────────────
    This fix requires:

    Files: [N]
    Edits: [N]

    Maximum allowed:
    2 files / 3 edits

    Suggested split:

    Task A: [description]
    Task B: [description]

    Please open a new chat for each task.
    ─────────────────────────────────────────

---

### PLAN BLOCK

    PHASE 3 — PLAN
    ─────────────────────────────────────────
    CHANGE TYPE:  [BUG FIX | IMPROVEMENT]
    SCOPE:        [BACKEND | FRONTEND | BOTH]

    FILES CHANGING:
    1. [filename] — [summary]
    2. [filename] — [summary]

    FILES NOT TOUCHING:
    [list]

    EDITS:
    Edit 1: [filename] — [exact function or line] — [specific change]
    Edit 2: [filename] — [location] — [specific change]
    Edit 3: [filename] — [location] — [specific change]

    RISK CHECK:
    Break existing feature?         [Yes/No]
    New admin route needs auth?     [Yes — will call isAdminAuthorized() | N/A]
    Null crash possible?            [guard description or N/A]
    ─────────────────────────────────────────

---

# PHASE 4 — BUILD / FIX

Print header first.

    PHASE 4 — BUILD / FIX
    ─────────────────────────────────────────

Before making any edits, print this confirmation block and stop.

    READY TO EDIT
    ─────────────────────────────────────────
    I am about to make the following changes:

    Edit 1: [filename] — [what exactly will change]
    Edit 2: [filename] — [what exactly will change]

    Type YES to continue, or tell me to stop.
    ─────────────────────────────────────────

Wait for the user to confirm before proceeding.

Once confirmed, for each edit:

1. Locate the exact function or line.
2. Modify only the planned code.
3. Do not modify surrounding logic.
4. Save the file.

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
    [✓/✗] Fix addresses confirmed root cause
    [✓/✗] Error paths handled
    [✓/✗] No .map/.filter/.forEach on undefined
    [✓/✗] Frontend loading cleared in finally
    [✓/✗] Admin routes call isAdminAuthorized()
    [✓/✗] DB queries use prepare()
    [✓/✗] API responses use json() or badRequest()
    [✓/✗] Only planned files changed
    [✓/✗] No terminal commands used during editing
    [✓/✗] ≤ 3 edits made across ≤ 2 files

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
    ✅ [What was accomplished]

    WHAT WAS WRONG:
    [short plain English explanation]

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

    If something looks wrong after deploying, you can undo it by running:
    npx wrangler rollback

    NO — no action needed

    FILES CHANGED:
    • [filename]
    ─────────────────────────────────────────
