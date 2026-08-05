---
'@namzu/sdk': patch
---

cancelling a task no longer deletes a result it had already produced

`CompletionInbox.forget` cleared both the outstanding-work set and the queue of
completions waiting to be announced. The second was wrong.

A background worker finishes, its completion is queued for the next drain, and
the model — told nothing yet, and reading a tool that says it cancels a
*running* task — cancels it. The run then reported `cancelled` over work that
had been done, and the output existed nowhere else: not announced, not
claimable, not readable through the listing.

`forget` is about pending work, and a finished result is not pending work. It
now narrows to the outstanding set. The asymmetry with `claim`, which does clear
the queue, is deliberate: there a tool has just handed the model the same
result.
