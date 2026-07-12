---
"@namzu/openrouter": patch
---

Loop reliability (ses_015 Phase B): map vendor errors to the SDK's typed `ProviderRequestError` taxonomy (throttle/context-overflow/auth/bad-request/server/network/aborted), read retry-after and rate-limit reset headers into `retryAfterMs`, forward `ChatCompletionParams.signal` to the transport, disable vendor-internal retries so the SDK retry cap bounds physical attempts, and declare the `supportsAbortSignal` capability.
