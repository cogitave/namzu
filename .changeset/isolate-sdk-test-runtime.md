---
'@namzu/sdk': patch
---

The SDK runtime and API are unchanged. Supported source-checkout test scripts now write into a run-owned temporary directory and, after ordinary child completion, remove that directory only when its filesystem identity still matches the one the runner created.
