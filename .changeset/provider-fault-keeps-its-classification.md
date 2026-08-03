---
'@namzu/sdk': patch
---

A provider fault keeps the classification its driver produced

The stream turn flattened a classified `ProviderError` to its message and threw a fresh error in its place, so `retryable`, `status` and `retryAfterMs` were all discarded — and `NamzuError`'s default for `provider_error` is not-retryable. A 429 or 529 that had exhausted its backoff therefore settled the run **failed**, where the documented behaviour is a **pause** with a checkpoint to resume from. `toPlatformError` already projects the right shape; it was simply never handed one.

The asymmetry was visible in the codebase: the same fault raised inside the compaction verifier propagates untouched and does pause, so identical faults settled oppositely depending on whether compaction happened to run that iteration. A classified failure is now rethrown as itself, and an unclassified one keeps its cause.
