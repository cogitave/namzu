---
"@namzu/sdk": minor
"@namzu/openai": minor
"@namzu/deepseek": minor
"@namzu/openrouter": patch
"@namzu/google": patch
"@namzu/http": patch
"@namzu/zen": patch
"@namzu/cli": minor
---

The terminal now retries a model call that fails for a reason that may pass (a dropped connection, a 5xx, an overloaded server, a rate limit with a short wait) the way the reference terminal does, instead of stopping after three tries. It tries ten times, waits from half a second doubling to thirty-two seconds with a little added on top, treats a `Retry-After` as a minimum, gives up on a wait longer than a minute (the reply then pauses and Enter tries again), and believes a provider that says `x-should-retry: false`. A reply cut off by a dropped connection starts over and the half-drawn text is taken back. While it waits, the Working row reads `Retrying in 5s · attempt 2/10` and counts down; Esc interrupts it. Nothing needs changing in your setup.

SDK: `ProviderRetryConfig` gains optional `jitter` (`'full'` or `'proportional'`), `retryAfter` (`'exact'` or `'floor'`) and `retryMidStream`, `ProviderRetryNotice` and the `provider_retry` event gain an optional `restart`, `ProviderRequestError` gains `shouldRetry` (only `false` is acted on), `providerHttpError` takes `shouldRetry`, and `providerVendorError` reads `x-should-retry`. No default changed: `maxRetries` is still 3, jitter still full, `Retry-After` still exact, a stream that failed after output is still not retried unless a host sets `retryMidStream` (a host that does must drop what the failed attempt showed when it sees `restart`; the turn drops its own copy). Hosts that want the terminal's numbers pass them in `query({ retry })`.

`@namzu/openai` (API key and Codex) and `@namzu/deepseek` gain an optional `maxRetries`, passed to the vendor SDK. Left unset, the vendor default of two silent retries still applies; set `0` to see and count each retry in the kernel, as the terminal does. `@namzu/openrouter`, `@namzu/google`, `@namzu/http` and `@namzu/zen` now pass the response's `x-should-retry` header to the error they throw.
