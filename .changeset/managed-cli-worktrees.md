---
'@namzu/cli': minor
---

Add `namzu worktree create|list|fork|resume` and `/worktree` for managed Git
checkouts. Each checkout keeps its own conversation history; forking copies a
settled conversation into the new checkout's project. Uncommitted source files
stay in the source checkout, and Namzu never removes a worktree automatically.
