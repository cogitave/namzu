---
'@namzu/sdk': minor
---

Give runtime failures a code a host can branch on.

`PlatformError` was declared and never constructed — a shape nothing
produced and nothing consumed — while the runtime threw bare `Error`
everywhere. A caller catching a failure from `query()` could not tell "the
model rate-limited us" from "the run was configured wrong" from "that
checkpoint does not exist"; matching on message text was the only recourse,
and message text is not an interface.

- `NamzuError` implements `PlatformError` and extends `Error`, so it still
  behaves like one everywhere that only knows about `Error` — stack,
  `instanceof`, `cause`.
- `NamzuErrorCode` stays small on purpose: each member exists because a
  caller does something different about it (`invalid_config`,
  `provider_error`, `tool_error`, `not_found`, `plugin_error`,
  `capability_unavailable`, `storage_error`, `unknown`).
- `toPlatformError(unknown)` normalizes ANYTHING thrown into the declared
  shape — a `NamzuError`, a `ProviderError`, a plain `Error` from a
  dependency, or a thrown string. Without it, "handle errors from the SDK"
  means writing the same `instanceof` ladder in every caller. A
  `ProviderError` keeps its own classification (its code lands in
  `details.providerCode` and its `retryable` verdict is preserved, not
  recomputed).

Adopted at the runtime sites a host would actually branch on: strict
capability failures, provider stream errors, checkpoint-not-found, and
plugin hook errors. Exhaustiveness guards stay plain `Error` — those are
programmer bugs, not conditions to handle.
