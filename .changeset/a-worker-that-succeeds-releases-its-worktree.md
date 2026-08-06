---
'@namzu/sdk': patch
---

A delegated child releases its workspace when it succeeds, not only when it fails.

`AgentManager` had two workspace dispose sites and both were failure paths — the
non-success branch of `finalizeChild`, and the rollback in `failSubSession`. The
success branch disposed nothing, so a git worktree provisioned for a delegated
child outlived the child that used it. `.namzu/worktrees/` grew once per
successful delegation: the more reliable the workers, the faster it filled,
which is the opposite of the signal a leak usually gives.

Disposal now runs on every terminal path, from one shared place, so the two
cannot drift apart again.

**The archival backstop could not fire either, and now can.**
`ArchivalManager.archive` resolves a workspace only when `SubSession.workspaceId`
is set. For a spawn-created sub-session that field was written `null` and never
updated — `provisionSpawn` kept the ref on an in-memory record and nowhere else
— so the one persisted record that could have named the leaked worktree said
there was none. `provisionSpawn` now writes `workspaceRef.id` onto the
sub-session, inside the same compensating rollback as every other mutation
there. A sub-session with no provisioned workspace still records `null`; lazy
provisioning stays legal.

Two consequences worth knowing before you take the upgrade:

- **A worktree is gone once the child that owned it completes.** If you were
  reading a child's workspace after a successful delegation — through
  `AgentManager.getSpawnRecord(taskId)`, which is the only way that was
  available — read it from inside the child, or from a `subsession_idled`
  listener's own copy, before it settles. Disposal runs before that event.
- **`archive()` now resolves workspaces for spawn-created sub-sessions.** If you
  pass a `workspaceResolver`, it will start being called on this path, and an
  archive bundle may now carry a `workspace` field where it previously never
  did. The resolver contract is unchanged: return `null` for a ref that is
  unknown or already disposed, which is what it will be for a child that
  finished.
