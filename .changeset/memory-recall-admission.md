---
'@namzu/sdk': patch
---

Prevent automatic memory recall from accumulating overlapping reads after a
store timeout or cancellation. Hooks sharing the same store object skip recall
while an earlier pass is still outstanding, then read fresh state once it
settles. Explicit memory tools and separate store instances are unaffected.
This bounds optional work admission; it does not cancel underlying disk I/O.
