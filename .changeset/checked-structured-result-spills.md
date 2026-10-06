---
'@namzu/sdk': minor
---

Add opt-in `structuredResultSpilling: true` to built-in session logs. Large
screened structured tool candidates and accepted final JSON can use separate
checked spill references while their records remain within the 4 MiB ceiling.
The default keeps existing inline records; each spilled JSON body is limited
to 16 MiB. Live events and returned turns still carry the full value.

Use `readStructuredOutput` on a completed record from a verified log read to
restore accepted JSON. Completed-call recovery hydrates only the latest
selected completion and refuses missing or corrupt evidence without replay.
`readSpill` and spill stores accept optional byte limits and cancellation;
built-in bounded reads verify actual size, UTF-8, regular files and hashes.
Custom backends remain responsible for their own I/O limits. This does not
restore a pre-crash review decision or introduce general tool-data artifacts.
