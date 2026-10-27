---
'@namzu/sdk': major
---

Changed default under `query()`: reading the same lines of a file again, when the file has not changed and the earlier result is still in the conversation, now returns one sentence (`Unchanged since your earlier read of the same lines...`) with `facts.unchanged: true` instead of the lines. It never applies when the earlier result was cleared, summarised away or annotated, when the file changed, or when the window differs. A host that parses the repeated lines from a second `read` must read the earlier result instead; there is no switch to turn this off under `query()`, which always supplies `receiptVisible`; a host that calls the `read` tool itself, outside `query()`, passes no such hook and still gets the lines.

New optional members make this possible: `ToolContext.receiptVisible(callId, renderedFingerprint)`, `FileReadTracker.recordReadWindow` and `readWindow`, `ReadWindowEntry`, and the read facts' `unchanged`. A custom tracker takes part only by implementing the two window methods. A compaction restores the real lines of a file read, not the one-sentence answer.
