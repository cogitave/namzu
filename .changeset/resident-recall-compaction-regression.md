---
"@namzu/sdk": patch
---

Added integration regression coverage for resident evidence recall after
structured and sliding-window compaction. The tests verify that an exact receipt
removed from model context remains recoverable through the registered history
tools while the original pursuit boundary stays intact. Runtime behavior and
public APIs are unchanged.
