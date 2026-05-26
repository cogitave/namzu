---
'@namzu/sdk': patch
---

Accept plain-text `approve_plan` step lists and normalize them into canonical
step objects before execution. This keeps plan approval cards resilient when a
provider emits numbered prose instead of an array-shaped argument.
