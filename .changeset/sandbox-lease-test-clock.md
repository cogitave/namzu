---
'@namzu/sandbox': patch
---

Make worker lease regression tests deterministic under slow scheduling by controlling the test worker's clock. This changes validation only; sandbox runtime behavior is unchanged.
