---
'@namzu/sdk': major
---

A delegated git worktree can now be kept only when the child changed something. Pass `retention: 'retain-changed'` in `ChildWorkspaceRequest`: when the child ends, the manager removes the checkout if it has no uncommitted changes and no new commits, and keeps it otherwise. The git driver records the starting commit in `GitWorktreeBackendMeta.baseCommit`, `WorkspaceInspection` gained an optional `hasNewCommits`, and disposing a checkout whose branch never left the starting commit also deletes that branch (a branch with commits is never deleted). `SubSession.workspaceRetention` may now be `'retain-changed'`. Existing `'retain'` still keeps the checkout. Disposing a newly created git worktree now also deletes its branch when it still points to its starting commit; before, that branch remained. Use `retention: 'retain'` to keep both the checkout and branch, or create a separate branch before explicitly disposing the checkout.
