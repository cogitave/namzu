---
'@namzu/sdk': patch
---

Resuming a session no longer holds its whole log in memory to verify a checkpoint: the check now streams the log and keeps only the last entry, with the same result. On a generated 260 MB, 60,000-record log, peak memory for the check fell from about 550 MB to about 275 MB, and it completes inside a 48 MB heap limit. Nothing needs to change.
