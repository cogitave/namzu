---
'@namzu/sdk': minor
---

A retried invocation can be deduplicated

A request goes out, the connection drops, the client retries. Without a key that retry is a second full run — a second set of model calls, and a second set of whatever the tools did. The invocation lock does not help: refusing the retry with `ConcurrentInvocationError` is not what the caller wanted either, because they wanted the answer.

`AgentRunConfig.idempotencyKey` makes a duplicate arriving while the first is still running await it and receive its result — the error included, because both callers asked the same question once and telling one of them something different would make the key a lie.

In-flight only. A retry that arrives after the first has settled runs again: keeping the answer would turn deduplication into caching, and how stale an answer may be is the host's judgement, not the SDK's. Instance-scoped, like the lock — deduplicating across processes needs somewhere durable to record the key, which is a store the host owns.
