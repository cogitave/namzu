---
'@namzu/sdk': minor
---

six declarations that drive nothing are marked for removal

An audit of the kernel found primitives that are declared, reachable from the
published typings, and read by no code at all. None is deleted yet — they are
on the public surface, so they get the deprecation release the repository's own
policy asks for, and go in the next major.

They are worth naming individually, because a dead declaration is not merely
untidy. Each of these tells a reader something false:

- `HOOK_MAX_CONCURRENT` reads as a concurrency cap that is in force. Hooks run
  sequentially and always have, so a reviewer reasons about batching that does
  not happen. Do not "fix" it by batching — ordering is the contract hooks are
  written against.
- `MAX_RECENT_ACTIVITIES` — no list is trimmed to it.
- `AgentTask.progress` and the `progress_updated` lifecycle variant are a whole
  reporting channel with **no producer**. A host that switches on the event has
  written a branch that cannot run; one that waits for progress waits forever.
- `IterationCheckpoint.planStatus` is never set, so a host restoring a
  checkpoint to find out whether the plan was approved gets `undefined` for
  every run — approved or not — and cannot tell the two apart. Ask the plan
  manager.
- `ProbeOptions.otel` is unimplemented: setting it changes nothing.

Each now carries `@deprecated` and a note saying which of "unused",
"no producer" or "unimplemented" applies, so the next reader does not have to
re-derive it.
