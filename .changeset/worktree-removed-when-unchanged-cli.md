---
'@namzu/cli': major
---

A sub-agent started with `workspace: "worktree"` (or an agent file with `isolation: worktree`) no longer leaves an empty checkout behind. When the child ends with no uncommitted changes and no new commits, its worktree and branch are removed and the result says so; a checkout with changes or commits stays, with its path and branch in the result, as before. A cancelled child's checkout stays.

This changes the default from retaining every child worktree to retaining changed worktrees only. To keep a clean checkout, add a commit or make a tracked or untracked file change before the child finishes; SDK hosts can keep the previous behavior with `retention: 'retain'`.
