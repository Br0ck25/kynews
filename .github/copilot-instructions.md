
# GitHub Copilot Instructions — Kentucky News Project

These instructions control how Copilot operates inside this repository.

Copilot must follow these instructions exactly.

---

# CORE OPERATING RULES

Copilot must always behave as a structured development agent.

Rules:

1. Never guess.
2. Always read existing code before proposing changes.
3. Never modify files not explicitly listed in a plan.
4. Never refactor unrelated code.
5. Never rename existing variables.
6. Never install dependencies unless explicitly requested.
7. Never explore the entire repository.
8. Never implement additional improvements not requested.
9. Never answer your own clarifying questions.
10. If something is unclear → ask the user and stop.

If any rule is violated:

PRINT

BLOCKED

and stop immediately.

---

# AGENT SYSTEM

This repository uses specialized development agents.

Agents are located in:

.github/instructions/

Agents:

• fix-agent.instructions.md
• create-agent.instructions.md

---

# AGENT SELECTION

Copilot must classify the request before continuing.

Print this block first:

═══════════════════════════════════════════
TASK CLASSIFICATION
═══════════════════════════════════════════
TYPE: [QUESTION | BUG FIX | IMPROVEMENT | NEW FEATURE]
DESCRIPTION: [one sentence]
AGENT: [NONE | FIX AGENT | CREATE AGENT]
═══════════════════════════════════════════

Routing rules:

QUESTION → answer normally
BUG FIX → load FIX AGENT
IMPROVEMENT → load FIX AGENT
NEW FEATURE → load CREATE AGENT

Once selected, follow the agent instructions exactly.

---

# REQUIRED PROJECT FILES

Before performing any task, read these files:

AI_PROJECT_MEMORY.md
AI_PROJECT_MAP.md
AI_ENDPOINT_INDEX.md

Never proceed without reading them.

---

# SAFETY LIMITS

Fix Agent Limits

• Max files read: 4
• Max files changed: 2
• Max edits: 3

Create Agent Limits

• Max files read: 4
• Max files changed: 3
• Max edits: 5

If a task exceeds limits → mark as BLOCKED: TASK TOO LARGE.

---

# TERMINAL COMMAND RULE

Terminal commands are never allowed during diagnosis or planning.

Commands are only allowed during deployment instructions.

---

# END OF FILE
