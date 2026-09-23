---
'@namzu/browser': patch
---

`back`, `forward` and `reload` return once the page is back. They waited for `domcontentloaded`, which a page restored from the back-forward cache never fires, so going back in the Windows browser from WSL took 30 seconds and then failed although the page had already returned. They now wait for the navigation to commit, then up to 5 seconds for the document. A move the back-forward cache answered no longer says there is no page to go back to.
