---
'@namzu/sdk': patch
---

Compaction no longer leaves the conversation opening on an assistant turn.

After compaction the kept tail **is** the conversation: the summary is
written as a system message and every driver hoists system messages into
their own request parameter, so the first kept message becomes the first
message on the wire. A conversation that opens on an assistant turn is
rejected.

`findSafeTrimIndex` advanced past an orphaned `tool` message and never past
an `assistant` one. How often that bit depends on the shape of the history,
and the shape that matters most is the worst: in a **multi-step turn** — the
agent working through several tool calls without the user speaking in
between — the tail alternates assistant and tool with no user message in it
at all, so essentially every boundary landed wrong.

The failure was unrecoverable. The resulting rejection is not classified as
an overflow, so relief never fires and the run dies — compaction, whose
entire job is keeping a long run alive, becoming the thing that ends it.

The boundary now advances to a `user` turn. Where none lies ahead it falls
back to the nearest one behind **whose own tail is free of dangling tool
pairs**: two wire invariants are in play, and satisfying one by breaking the
other is not a fix. Where no boundary satisfies both, the input was already
unsendable and no cut makes it otherwise, so the prior behaviour stands
rather than a different invalid conversation being invented to replace it.

Also fixed alongside: the structured manager took
`Math.min(safeTrimIndex, desiredTrimPoint)`, and since the safe index only
ever moves forward of the desired one, that minimum resolved back to the
desired point every time — discarding the entire safety search. Whatever the
guard was reaching for, what it did was undo the line above it.
