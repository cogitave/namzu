---
'@namzu/sdk': patch
---

Publish `token_usage_updated` immediately after every automatic context edit, before the next provider request. The event keeps cumulative usage and cost intact while reporting the estimated post-compaction context and window provenance. An insufficient stale-tool-result clear is now staged until summary verification succeeds, so cancellation or verification failure cannot leave half of a compaction visible.
