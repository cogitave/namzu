---
'@namzu/sdk': major
---

`WriteFileTool` now refuses an existing file whose complete body differs from the exact body captured by the run's `FileReadTracker`, instead of silently replacing that newer body. Read the file again and recompute the full replacement before retrying. Hosts that implement only the older boolean read tracker retain their previous behavior; the guard is an admission-time preflight and does not claim cross-process compare-and-swap publication.
