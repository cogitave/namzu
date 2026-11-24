---
'@namzu/cli': patch
---

An extension now shows as running only once its query endpoint accepts connections, so a query sent the moment it shows as running no longer fails with `query-unreachable` on a slow machine. An endpoint that does not open within 10 seconds of the extension's first status restarts it like a missing hello. Nothing to change on your side.
