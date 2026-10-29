---
'@namzu/sdk': patch
---

Prevent resumed sessions from stopping with a context-refill error when compaction sheds host reminders or recorded context and the host adds them back. These runtime notes still count toward the request budget, while the refill guard continues to bound repeated growth from conversation messages and tool output.
