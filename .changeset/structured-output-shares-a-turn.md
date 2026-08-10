---
'@namzu/sdk': patch
---

A structured answer is no longer accepted while the model is still waiting on
its own question.

When the model called `structured_output` **and another tool in the same turn**,
the run settled immediately: the other tools had already executed, their results
went to no reader, and the answer recorded as final was the one the model
composed *before* it saw them. Side effects fired into a void, and the run was
graded on an answer formed while a question was outstanding.

A shared turn now relays instead — the results go back and the model answers
again with them in hand. This is the guard `terminalToolOutput` has always
applied to the identical situation two methods away; the two settle rules simply
disagreed.

**What changes for a caller.** A run that produced a shared turn used to end
there and now spends one more turn, so it costs slightly more and returns the
later answer rather than the earlier one. That later answer is the point: the
earlier one was formed without information the model itself asked for. Runs
whose model calls `structured_output` on its own — essentially all of them —
are byte-identical, including the immediate settle.

Still bounded by `maxIterations`, like every other non-settling turn. The prose
retry limit deliberately does not apply: a turn that shares is not a turn that
refused to answer.
