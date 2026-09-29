---
'@namzu/sdk': minor
---

Memory searches can now bound candidate scans with `maxScanned` and continue using `scanOffset`. Results report `truncated`, `scannedCount` and `nextScanOffset`, with `totalCount` counting only matches in an incomplete page. `search_memory` uses a 256-candidate page and accepts `scan_offset`; repeat with the returned offset when an older memory may match. Automatic recall also searches at most 256 recent candidates by default, configurable through `MemoryRecallOptions.maxScanned`. Disk stores select the page before reading its bodies. A direct `list` call without `maxScanned` retains its full-search behavior.
