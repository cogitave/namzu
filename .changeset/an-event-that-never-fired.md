---
'@namzu/sdk': major
---

Removed the task-progress reporting channel, which never had a producer: the
`progress_updated` variant of `AgentLifecycleEvent`, the `AgentTask.progress`
field, and the `AgentTaskProgress` type.

**What breaks.**

- `AgentLifecycleEvent` no longer includes
  `{ type: 'progress_updated'; taskId: TaskId; progress: AgentTaskProgress }`.
  A listener with a `case 'progress_updated':` branch is now a type error, and
  an exhaustive `switch` over the union will fail to compile until that branch
  is deleted.
- `AgentTask.progress` is gone. Reading `task.progress` is now a type error.
- `AgentTaskProgress` is no longer exported. An annotation naming it will not
  resolve.

**What to do instead: delete the code that touched them. Nothing replaces it.**
All three were one channel and nothing in the SDK ever drove any part of it —
no emit site for the event, no write to the field. A `case 'progress_updated':`
branch has never executed, and `task.progress` has been `undefined` on every
task that has ever existed. If you were waiting on progress to arrive, you were
waiting on something that could not come; this release stops advertising it, it
does not change what your code observes at runtime.

Both declarations carried `@deprecated No producer. Removed in the next major.`
in a shipped release, so this is that deprecation being honoured on schedule
rather than a surprise removal.

If you need per-task progress, the live surface is the run event stream —
`tool_progress` carries a tool's own progress messages, and the activity store
(`activity.progress`) carries structured activity updates. Neither is affected
by this change.

**Why removal rather than building the producer.** Emitting it would be a new
feature. Unlike the other producerless events in this codebase, this one has no
half-built machinery waiting on it — no wire mapper case, no reporter case, no
test fixture. There is nothing to finish, only a declaration to stop making.

**Scope note, because a much wider removal was proposed and rejected.** This
release was drafted against an audit finding of 23 "declared but nothing reads
it" items. Most did not survive verification and are deliberately **not**
removed: `memoizeAsync`, `toWireRunStatus`, `startBidiRun`,
`createMockBidiProvider`, `createRunReporter`, `parseWorktreeList`,
`compressShellOutputFull`, `bodySaysContextOverflow`,
`classifyProviderHttpStatus`, `resolveSkillChain`, the `SkillChain` and
`SkillLoadResult` fields, and `InvocationState.metadata` / `.services` /
`.parentChain`. Several have callers inside this package, two are the entry
points of the documented duplex runtime, and `InvocationState` is delivered
intact to `ToolContext.invocationState` for a host's own tools to read. If you
use any of them, this upgrade does not touch them.
