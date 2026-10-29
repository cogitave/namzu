---
'@namzu/cli': minor
---

Agent files in `~/.namzu/agents` and `.namzu/agents` can now set `disallowedTools`, `effort`, `maxTurns`, `background`, `isolation: worktree` and `skills`, and `model: inherit` keeps the session's model. Nothing changes for an existing file. A file with `isolation: worktree` has its launch reviewed, since it works in a checkout of its own.
