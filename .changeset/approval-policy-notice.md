---
'@namzu/sdk': minor
---

Tell the model when the approval policy changes, once, in the slot it already reads.

The model plans around how closely it is being watched. A run that silently stops asking a human leaves it batching destructive calls it expects to be reviewed; one that silently starts leaves it waiting on permission nobody is left to give. Neither is visible to it.

`RunApprovalPolicy` gains `takeUnannouncedChange()` — **read-and-clear**, so the notice is said exactly once. A repeated notice is worse than none: the second copy reads as a second change, and the model will believe supervision moved again.

The notice rides the ephemeral trailing system message that a step's guidance and skills already use. It applies to what happens next, not to the run's history, so pushing it onto the message log would accumulate one stale instruction per iteration.

Consecutive changes collapse: A→B→C is announced as A→C, keeping the ORIGINAL `from`. Three swaps between two model calls are one fact by the time the model can act on one, and the true statement is about what it planned under versus what it is under now — not the history in between.
