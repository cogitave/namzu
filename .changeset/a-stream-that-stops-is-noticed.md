---
'@namzu/sdk': minor
---

New `withStreamIdleTimeout(provider, { idleTimeoutMs })` — a per-chunk watchdog in the same decorator shape as `withProviderRetry` and `withProviderFallback`, so it composes with both.

A stream that opens successfully and then goes quiet trips nothing. Each driver has a whole-*request* timeout, and a stall does not reach it: the request is fine, the bytes have stopped. One driver had this written inline and defaulted it to off, so no driver re-armed on a stall unless a host set a config key it had no reason to know about. A run in that state is not slow, it is stuck — holding its budget, its claim and its process, and settling never.

The failure is classified `network`, which is what `withProviderRetry` and `withProviderFallback` already act on: a stalled stream is retried by the layer above, or the chain moves on. A bespoke classification would reach them as an unknown they treat as fatal.

Disabled (`0`, negative, non-finite) returns the provider **unwrapped**, not wrapped and inert — a disabled watchdog racing a promise per chunk costs the hottest path in the runtime a timer and a closure for nothing.
