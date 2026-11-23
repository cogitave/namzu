---
'@namzu/sdk': patch
---

`wrapProviderWithProbes` now passes a provider's `resolveContextWindow` through, so a provider wrapped for probes keeps the window its own model list reports instead of falling back to the model-name table.
