---
'@namzu/sdk': major
'@namzu/openrouter': patch
---

Bound provider stream silence, including query-owned advisory calls and
RouterAgent routing decisions, compaction verifiers and model-graded eval
judges, to five minutes by default and abort the stalled provider transport,
with network-classified retry and fallback recovery where those policies
apply. This changes the previous default, under which a provider iterator could
remain silent forever. Set `streamIdleTimeoutMs: 0` on the run, agent, manual
compaction, verifier, or judge config to keep the old unbounded behavior, or set
a positive millisecond value to choose a different bound.

Queries whose caller signal is already aborted now settle as cancelled before
starting provider, provider-metadata, or tool work. A later cancellation also
settles while an optional context-window resolver remains pending, even when
that resolver ignores its signal. With no caller cancellation, `timeoutMs`
bounds the optional metadata lookup, aborts its private transport signal, and
falls back to the static context-window table instead of blocking the run.

The OpenRouter context-window lookup now forwards cancellation to its model-list
transport. Only fulfilled listings are cached, so cancelling one concurrent
query cannot abort another query's shared metadata request or force that query
onto the static context-window table.

`runExperiment({ timeoutMs })` now applies one validated wall-clock deadline to
both case execution and scoring. Scorers receive its optional cancellation
signal; a non-cooperative scorer is detached, and `judgeScorer` forwards the
signal to its bounded provider transport. Values outside the positive platform
timer range are refused before a case starts; omit the field for the prior
unbounded case behavior.

Compaction verification inside a query now carries the run cancellation cause
to its provider transport without placing a second idle timer around retry and
fallback. Public `buildVerifiedSummary`, `compactNow`, and `compactRegion`
calls bound raw provider silence themselves and accept optional `signal` and
`streamIdleTimeoutMs`; malformed values and pre-cancelled manual work are
refused before provider work or a no-op result.

HTTP embedding batches now have a 30-second whole-request default, including
response-body reads, where the previous default could wait forever. Set
`requestTimeoutMs: 0` on `HttpEmbeddingProvider` to keep the former unbounded
behavior. Invalid timeout values and non-positive or fractional `batchSize`
or `dimensions` values are refused at construction instead of silently
disabling the bound or entering a non-progressing batch loop. Successful HTTP
responses must contain exactly one unique, in-range result per input and finite
vectors of the configured dimension; malformed or incomplete batches are
refused atomically instead of reaching ingestion with missing embeddings.

Public RAG operations accept optional cancellation context. The shipped
`knowledge_search` tool forwards its run-owned signal through
`KnowledgeBase`, retrieval or ingestion, and the embedding provider. The HTTP
provider preserves the caller's exact cancellation reason while aborting only
its private fetch transport. Custom embedding providers receive the signal as
a cooperative request; callers still own their wait boundary if a custom
implementation ignores it. Default retrieval and ingestion recheck authority
after that custom call settles, so a late result cannot start a vector search
or persist chunks after cancellation. `VectorStore.search` and `upsert` now
receive the same optional operation context. The default pipelines also race
those store promises against cancellation, so a non-cooperative custom store
cannot leave the public query or ingestion call pending forever.

A2A agent-card discovery now has a 30-second whole fetch-and-body default and
accepts an optional caller signal and `timeoutMs`; set `timeoutMs: 0` to retain
the former unbounded behavior. `A2ADelegate.timeoutMs` now starts before
`message/send` and bounds the whole delegation instead of polling only. A
pre-cancelled dispatch starts no remote work, pending fetch and body promises
cannot hold `waitForTask`, and caller cancellation preserves its exact cause on
the private transport. Poll and delegation timers are validated at
construction. Once a safe task id exists, cancellation or timeout sends one
independently bounded `tasks/cancel`; during initial task creation the client
keeps a short cleanup grace and explicitly reports an unknown remote outcome if
the peer never returns an addressable id. Poll replies are bound to that initial
id, and transport or protocol failures after it is known make the same bounded
cleanup attempt before the original failure is returned. An `input-required`
task is also bounded-cancelled before the delegate reports that it cannot
supply the requested input.
