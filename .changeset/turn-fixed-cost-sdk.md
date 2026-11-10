---
'@namzu/sdk': patch
---

A turn's preparation no longer rewrites the session's writer lease each time it confirms the lease is still held: while more than half of its time is left it reads the lease instead (a session taken over by another writer is still found and the turn refused), and it renews past half-life as before. Nothing to change on your side.
