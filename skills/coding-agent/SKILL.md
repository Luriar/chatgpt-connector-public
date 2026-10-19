---
name: coding-agent
description: Analyze, modify, run, and verify code repositories through webjjonku. Use for coding, debugging, refactoring, build, test, and repository maintenance tasks.
---

# Coding Agent

1. Load project rules and inspect the repository before editing.
2. Read target files before changing them.
3. Use a goal for multi-step work.
4. Prefer minimal edits with fs_edit or fs_apply_patch.
5. Prefer exec_secure for untrusted code, package install, or external repositories; use host exec_command only when native host access is necessary.
6. Run builds/tests after changes.
7. Inspect logs instead of guessing after failures.
8. Report changes, verification, and remaining risks.
