---
"@namzu/lmstudio": patch
---

Loop reliability (ses_015 Phase B): map vendor errors to the SDK's typed `ProviderRequestError` taxonomy (context-overflow/auth/bad-request/server/network/aborted), forward `ChatCompletionParams.signal` to the transport so an in-flight call is actually cancelled, and declare the `supportsAbortSignal` capability.

Context exhaustion is now typed. LM Studio reports it as a *successful* prediction with stopReason `contextLengthReached` and empty content, which the loop previously accepted as an empty answer; it is raised as a `context_overflow` error instead, so the runtime compacts and reissues.

No `Retry-After` extraction and no vendor retry knob: LM Studio is a local server, so backoff is the SDK's jittered exponential schedule and the SDK's retry cap is the only multiplier on request count.
