---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A managed Git worktree is kept when another running session or subagent is
working in it, instead of being removed with `worktree remove --force` and
taking that session's uncommitted files with it.

`GitWorktreeDriver.dispose` asks who is working in the checkout before it
removes anything, and throws `WorkspaceInUseError`, naming the checkout and the
folder the other session works in, when a live holder remains. A path nothing
holds is removed exactly as before. The answer comes from a new
`WorkspaceHoldStore` (`DiskWorkspaceHoldStore`, records under
`<NAMZU_HOME>/workspace-holds`, a holder whose process is gone is not counted),
and the driver takes one through the new `GitWorktreeDriverConfig.holds`
option.

The CLI records a holding when a session starts inside a managed checkout, when
a one-shot `namzu exec` run works in one, and while a delegated child works in
one, so the child's own cleanup and any other removal see it. A child lets go
of its holding when it ends, whether or not its checkout is kept, so a kept
checkout is not refused later for a session that is no longer running.
`ManagedWorktrees` gains `checkoutAt`, `hold` and `holders`,
and `holdSessionCheckout` is exported for a launch that wants the same record.
