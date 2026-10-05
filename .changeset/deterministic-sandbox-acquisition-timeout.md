---
'@namzu/sdk': patch
---

Make the held sandbox acquisition timeout regression deterministic by controlling its clock after sandbox creation starts. Runtime cancellation and timeout behavior are unchanged.
