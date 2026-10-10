---
'@namzu/desktop': patch
---

The Details of a reply that failed with a 500, 502 or 503 before any answer arrived no longer end with "No usage was reported for the failed attempts."; there was nothing to report. They read as labelled lines only (the provider, what failed, a request ID when the vendor sent one). The usage line stays for a reply that did arrive without a usage count.
