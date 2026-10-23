---
'@namzu/sdk': patch
---

Spill a large `compaction` summary beside the log instead of inline. A `context-rewrite` re-base keeps its summary small, but nothing enforced it — a summary under the 4 MiB record cap was written inline and could bloat the session file and make replay heavy. A new `compactionSpillAboveBytes` option (default 256 KiB, capped at `spillAboveBytes`) spills a summary over the bound through the existing spill store; the fold reads it back transparently, so the on-disk record stays small and the model sees the same conversation. Defence-in-depth alongside the re-base fix, which already keeps summaries small in normal operation.
