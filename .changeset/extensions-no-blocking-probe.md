---
'@namzu/cli': patch
---

An extension's page no longer opens blank or shows its data late on Windows. The engine used to freeze for about a second and a half each time it checked which process hosts an extension, and it did that on every list read; it now reads that once per process, without waiting, and the page-open path does not check at all. Page opens, page-info calls and queries are now logged with their duration.
