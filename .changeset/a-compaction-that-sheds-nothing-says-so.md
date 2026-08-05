---
'@namzu/sdk': minor
---

A compaction pass now reports both of its outcomes.

Two gaps, in opposite directions, in the same function.

**A compaction that sheds nothing was invisible to everyone.** All three decline
paths — the reducer throws, it returns no fewer messages than it was given, or
its result splits a `tool_use` from its `tool_result` and is refused wholesale —
reached a log line and stopped there. A host that silences its logger, which
every command-line entry point does, made a failed compaction invisible to the
user, to the host *and* to the model at once. The run then continued at full
context toward a provider rejection several turns later that named none of this.
A shed that did not happen is exactly as consequential as one that did, and only
one of them was on the wire.

New `compaction_failed` event (wire: `compaction.failed`) carrying `cause`
(`reducer_threw` | `shed_nothing` | `split_tool_pair`), the unchanged message
count, and the reducer's error where there was one. The cause is on the event
because the three want different responses: one may succeed next pass, one will
decline identically every time, and one is a reducer bug that `findSafeTrimIndex`
exists to prevent.

**And a compaction that succeeded was invisible on the path most hosts take.**
`compaction_completed` was emitted only from the structured working-state path.
The reducer path — taken by any host-supplied `contextReducer` and by
`strategy: 'sliding-window'` — emitted nothing at all, so the event whose own
documentation says it exists because "a host could not show the user that context
was dropped" never reached the hosts most likely to need it. It is emitted from
both paths now.

That second one was found by a test written for the first: asserting that a
successful compaction does *not* report a failure is what showed it reported
nothing.

**If you switch exhaustively over `RunEvent`, you need a case for
`compaction_failed`.** Nothing else changes: no existing event's shape moved, and
a host that ignores unknown events is unaffected. The A2A bridge deliberately
does not forward either compaction event — a peer models a task lifecycle and
cannot act on how this runtime manages its own context.
