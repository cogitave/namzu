---
'@namzu/sdk': major
---

`wait_for_job` now returns `success: true` when its idle or total wait bound is reached. Previously that outcome returned `success: false` and was treated as a failed tool call. Callers that used `success === false` to detect a wait timeout must check `data.timedOut` (`idle` or `wall`) instead. The job keeps running in either case.

The tool now includes a bounded partial output preview and absolute `nextOffset` on timeout, and accepts `from_offset` on the next call so callers can continue without receiving the same bytes again. It reports output omitted by the wait's 32 KiB cap separately from bytes lost by the job registry's retention cap.
