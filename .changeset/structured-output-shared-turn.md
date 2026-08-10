---
'@namzu/sdk': patch
---

A structured answer no longer settles a run on top of tool results nobody read

`captureStructuredOutput` ended the run on any successful `structured_output`
result, without regard for how many calls the turn carried. Its neighbour forty
lines away, `terminalToolOutput`, refuses exactly that situation and writes the
argument down: "a model that asked for other work meant to see those results".

The consequence is worse than a discarded answer, because of the order things
happen in. The batch executes in `runToolReview` *before* either of these is
consulted — so a model that emitted `structured_output` alongside `write`, a
delegation, or any other call had those calls run, side effects and all, and
then the run broke out of the loop. The results went into the transcript and no
model turn ever read them. Work was spent, nothing consumed it, and nothing
said so.

There is a second reason, sharper than the neighbour's. The model produced that
answer in the same turn as a request for information it did not yet have — it
would not have asked otherwise — so the answer was under-informed by the model's
own account, and settling shipped it as final.

`structured_output` now settles the run only when it is the only call in its
turn. Sharing a turn relays: the results already in the transcript go back to
the model and the next turn produces the answer with them in hand. Refusing to
*execute* the batch was the other candidate and was rejected — the defect is not
that the tools ran, it is that nobody read them.

**What you will notice.** A run whose model pairs `structured_output` with
another call now takes one more turn, and `run.structuredOutput` holds the
answer formed after those results rather than before them. If your model always
calls `structured_output` alone, nothing changes. Relays are deliberately *not*
charged to `structuredOutput.maxRetries`: that budget bounds a model that cannot
satisfy the schema, and this one did — a run that reads a file per turn while
optimistically attaching its answer is making progress and must not be reported
as `structured_output_failed`. `maxIterations` bounds it, as it already bounds
the same pathology for terminal tools.

`patch`: no exported symbol, type, or default changes. A behaviour that was
losing requested work is corrected.
