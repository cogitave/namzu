---
'@namzu/desktop': patch
---

An extension's page shows "Opening" in its slot until the page is drawn instead of a blank area, and Desktop no longer re-reads the extension list every 4 seconds while a page is open (state changes still refresh it, in one batch).
