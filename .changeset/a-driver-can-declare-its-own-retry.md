---
'@namzu/sdk': major
---

New optional `LLMProvider.retryDefaults`. A driver can declare the retry behaviour its vendor wants, merged inside `withProviderRetry` between the generic default and whatever the caller passed.

One config was applied to every member of a provider chain. An operator running [expensive primary, cheap self-hosted backup] could not give the backup a shorter budget or a different ceiling on a server-directed `Retry-After` — the two have different failure shapes and different costs per attempt, and only the driver knows which. The host configuring a chain is choosing between vendors, not tuning each one's transport.

The merge is `{ ...DEFAULT, ...provider.retryDefaults, ...options.config }`, and the order is the contract: a driver's declaration is a *default* and a caller's config is an *intention*. Reversing it would let a driver override the operator, including re-enabling retries a host had switched off.

Merged inside `withProviderRetry` rather than at `query()`'s call site, because that function is exported: a host wrapping its own chain gets the same precedence instead of the generic default.

**Breaking:** `ProviderDriverConformanceOptions` now requires `retryDefaults` — a value, or `undefined` with the reason written down. A new driver package that never made the decision does not typecheck. Existing drivers all declare `undefined`: the generic default suits them.
