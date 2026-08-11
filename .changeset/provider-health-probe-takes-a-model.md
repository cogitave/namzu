---
'@namzu/sdk': minor
---

a provider health probe can be told which model to check

`LLMProvider.healthCheck` and `LLMProvider.doctorCheck` now take an optional
`model`. Both were declared no-argument, and that made a model-aware probe
unreachable: `ProviderRegistry.create()` hands back an `LLMProvider`, not the
concrete driver, so a driver whose config carries no model had nowhere to get
one and hardcoded an id instead — which is how one of them came to probe a model
nobody ran and could not pass at all.

**What you do: nothing.** The parameter is optional on an already-optional
method, so an existing implementation that takes no argument still satisfies the
interface and an existing call site still compiles. A driver is free to ignore
the argument — one that probes an endpoint rather than a model has no use for
it — and passing it is always safe.

`doctorCheck` may now return a SUBTYPE of `DoctorCheckResult`, so a driver can
carry its own machine-readable detail while `runDoctor()` keeps reading
`status`.

`withProviderRetry` and `withProviderFallback` forward the model to the wrapped
driver. They rebuilt the provider as an object literal and spelled the forwarded
methods `() => provider.healthCheck?.()`, which would have dropped the argument
silently: the call still happens, the driver still answers, and the answer is
"there was nothing to check" — an unusable probe produced by wrapping alone.
