---
'@namzu/cli': patch
---

Avoid returning an underfilled conversation-search response solely because an internal SDK index page ended. Search can follow up to seven internal continuations while preserving its existing requested match count, 12,000-byte match output allowance and 8 MiB read ceiling. Public cursors still resume remaining work, and each internal page revalidates scope and source integrity. A later validation failure removes that run's accumulated matches from the current response; cancellation still aborts the call. Run counts describe distinct runs visited within the response.
