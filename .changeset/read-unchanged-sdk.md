---
'@namzu/sdk': minor
---

Reading the same lines of a file again, when the file has not changed and the earlier result is still in the conversation, now returns one sentence (`Unchanged since your earlier read of the same lines...`) with `facts.unchanged: true` instead of the lines. It never applies when the earlier result was cleared, summarised away or annotated, when the file changed, or when the window differs.

New optional members make this possible: `ToolContext.receiptVisible(callId, renderedFingerprint)`, `FileReadTracker.recordReadWindow` and `readWindow`, `ReadWindowEntry`, and the read facts' `unchanged`. `query()` wires `receiptVisible` from the live history, so a hosted turn gets the behaviour by default. A host that runs `read` itself gets it only by passing `receiptVisible`, and a custom tracker takes part only by implementing the two window methods; without them reads return the lines as before.
