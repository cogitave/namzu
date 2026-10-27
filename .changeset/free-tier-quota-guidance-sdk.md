---
"@namzu/sdk": patch
---

The hint of the `provider.rate_limit` failure explanation no longer advises lowering concurrency, which does not apply to a single request; it says to wait for the retry delay or the quota window, or to continue on another model or provider. Anything that matched the old hint text needs the new wording.
