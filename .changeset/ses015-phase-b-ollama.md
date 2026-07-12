---
"@namzu/ollama": patch
---

Loop reliability (ses_015 Phase B): map vendor errors to the SDK's typed `ProviderRequestError` taxonomy (context-overflow/auth/bad-request/server/network/aborted), and map `done_reason` onto `finishReason` — it was hardcoded to `stop`, so a length-truncated response looked like a complete one.

`supportsAbortSignal` is declared **false**, honestly. The vendor SDK's non-streaming `chat()` exposes no signal path, so an in-flight call cannot be cancelled; the client checks the signal at the call boundary so a pre-aborted run never issues a request, and the streaming path aborts best-effort. The SDK's model-call bound means a hanging Ollama request can no longer hold the run past its timeout — the loop stops waiting on it, though the request itself may still be in flight.

No `Retry-After` extraction and no vendor retry knob: Ollama is a local server, so backoff is the SDK's jittered exponential schedule and the SDK's retry cap is the only multiplier on request count.
