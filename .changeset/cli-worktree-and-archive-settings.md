---
'@namzu/cli': minor
---

New settings: `worktrees.branchPrefix` (the start of a new worktree's branch, default `namzu`, so `namzu/<name>` is unchanged), `worktrees.location` (a folder where new worktrees are made, one folder per project inside it; unset keeps today's place), `worktrees.sparseFolders` (a new worktree holds only those project folders) and `archiveInactive` (`never` by default, or `1d`, `7d`, `30d`: the desktop host archives a conversation idle that long, never one that is running or has background work, never deleting anything). The three worktree keys are read from your own file and the managed file only; a project file that sets them is ignored with a notice. Nothing changes until you set one.
