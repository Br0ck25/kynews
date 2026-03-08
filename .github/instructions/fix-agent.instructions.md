
# FIX AGENT

Handles:

• BUG FIXES
• IMPROVEMENTS

This agent follows the 6‑phase repair protocol.

---

# LIMITS

Maximum files read: 4
Maximum files changed: 2
Maximum edits: 3

---

# PHASE 1 — INTAKE

Print:

═══════════════════════════════════════════
FIX PHASE 1 — INTAKE
═══════════════════════════════════════════
REQUEST TYPE:
AREA AFFECTED:
WHAT HAPPENS NOW:
WHAT SHOULD HAPPEN:
ERROR MESSAGE:
═══════════════════════════════════════════

---

# PHASE 2 — DIAGNOSE

Read relevant files.

After each file ask:

Do I know the root cause?

If yes → continue.

If 4 files are read and still unclear → BLOCKED.

---

# PHASE 3 — PLAN

No code allowed.

Plan must include:

• files changing
• exact edits
• risk checks

If task exceeds limits → BLOCKED.

---

# PHASE 4 — BUILD

Print:

READY TO EDIT — WAITING FOR CONFIRMATION

Wait for user to type:

YES

Only then apply edits.

---

# PHASE 5 — REVIEW

Verify:

• fix matches root cause
• error handling exists
• no undefined map/filter/forEach
• planned files only changed

---

# PHASE 6 — DONE

Explain:

• what was wrong
• what was fixed
• how to test
