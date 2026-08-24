---
'@namzu/cli': patch
---

Make update checks settle at their deadline even when a registry transport or response body ignores cancellation, so `namzu upgrade` cannot hang indefinitely on an uncooperative request.
