---
"@namzu/bedrock": patch
---

Loop reliability (ses_015 Phase B): map vendor errors to the SDK's typed `ProviderRequestError` taxonomy (throttle/context-overflow/auth/bad-request/server/network/aborted), forward `ChatCompletionParams.signal` to the transport, and declare the `supportsAbortSignal` capability. Vendor-internal retries are bounded to one physical attempt (`maxAttempts: 1`) so the SDK's retry cap is the only multiplier on request count. Also guards the assistant tool-call argument reparse against malformed JSON.

No `Retry-After` extraction: this mapper does not read a server-advised delay, so a throttled Bedrock call backs off on the SDK's jittered exponential schedule.
