---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Add optional cancellation signals to `ToolContext.captureRunEvidence` and
`RunStore.captureTextEvidence`. Existing implementations that accept fewer
arguments remain compatible; custom stores should observe the supplied signal
to stop their own I/O promptly.

Tool evidence capture now observes the tool's deadline and nested dispatch
cancellation, and refuses use after the tool call settles even if its parent
run is still working. Cancelling a local read leaves other calls available.
Queued cancelled captures are skipped without releasing a writer lock early.
An uncooperative custom store can still delay later appends until its pending
operation settles, although the cancelled caller stops waiting immediately.
CLI conversation search and exact reads also forward their operation signal
when capturing live evidence.
