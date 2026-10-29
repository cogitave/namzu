---
"@namzu/cli": minor
---

The environment context now names the host command execution shell and OS release, and reports detected linked git worktrees alongside the date and branch. Shell facts use the command runner's resolver rather than the login shell; sandbox guest shell selection is described separately.

Add `ultrathink` as a keyword for the existing one-turn max-effort composer trigger. Its default remains off. Set `composerTriggers.builtin.max-effort` to `suggest` for an Alt+W opt-in or `arm` for directly typed requests. Only effort levels published by the selected model are used; models without a menu get no invented fallback.
