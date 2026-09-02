---
title: RAG embedding request bounds
description: Reference for HTTP embedding deadlines, response integrity, cancellation propagation across public RAG operations, transport ownership, and the explicit unbounded compatibility option.
type: Reference
status: stable
resource: packages/sdk/src/rag/embedding.ts
tags: [sdk, rag, embeddings, timeout, cancellation]
generated: { by: human:bahadirarda, at: 2026-08-19T00:00:00Z }
---

# RAG embedding request bounds

`HttpEmbeddingProvider` sends text to a caller-selected HTTP endpoint in
batches. Each batch owns a whole-request deadline: connection setup, response
headers, and the response-body read all have to finish before that deadline.

The default is `DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS`, currently **30,000 ms**.
Set `requestTimeoutMs` to another integer from `1` through the platform timer
maximum (`2,147,483,647`) to choose a different bound. Negative, fractional,
non-finite, and over-range values are refused when the provider is constructed,
before text or credentials reach the network.

`requestTimeoutMs: 0` restores the former unbounded behavior. Use it only when
another transport owner already enforces an equivalent deadline.

The provider also requires `batchSize` and `dimensions` to be positive safe
integers. A zero or negative batch step does not describe a smaller batch: it
prevents the batch loop from advancing, so it is refused rather than coerced.

## Response integrity

An HTTP 2xx status proves only that the server answered. Before returning a
batch, the provider requires the response to contain exactly one unique,
integer, in-range index for every input. Each embedding must contain exactly
the configured number of finite numeric coordinates. Reordered records are
placed back in input order; missing, duplicate, out-of-range, malformed, or
dimension-mismatched records reject the whole batch. The ingestion pipeline
therefore never persists a chunk list containing a missing embedding from a
nominally successful HTTP response.

## Cancellation path

Public RAG work accepts `RAGOperationOptions`, whose optional `signal` follows
the operation rather than becoming part of retrieval query data. The same
signal reaches both supported paths:

```text
KnowledgeBase.query  -> DefaultRetriever         -> EmbeddingProvider.embedQuery
KnowledgeBase.ingest -> DefaultIngestionPipeline -> EmbeddingProvider.embed
```

The same operation context then reaches `VectorStore.search` or
`VectorStore.upsert`. Default retrieval and ingestion race host-supplied store
promises against cancellation as well as forwarding the signal. A custom store
that ignores the signal may continue its own side effect, because the SDK
cannot close I/O it does not own, but it cannot keep the public RAG operation
pending or make a late search result advance the pipeline.

`createRAGTool` supplies its `ToolContext.abortSignal` automatically. Pressing
Stop, reaching the run deadline, or reaching the per-tool deadline therefore
closes the shipped HTTP embedding transport instead of merely abandoning the
executor's wait.

The HTTP provider creates a private transport controller. Caller cancellation
flows into that controller with the caller's exact reason; the request deadline
never aborts the caller's controller. If a transport converts every abort into
a generic `AbortError`, the public operation still rejects with the caller's
original reason. A request deadline rejects with `name === 'TimeoutError'` and
uses that same error as the private transport's abort reason.

## Custom providers

`EmbeddingProvider.embed` and `embedQuery` receive the optional operation
signal. This is a cooperative contract for host-supplied implementations: the
SDK cannot close I/O it does not own. A query's tool executor still bounds how
long the run waits for an uncooperative tool, but detaching a wait is not the
same as stopping its underlying network request. Custom providers should pass
the signal to every owned transport and check an already-aborted signal before
starting work.

The default ingestion and retrieval implementations also check the signal at
operation admission and again after a custom embedder settles. A provider that
ignores cancellation may finish its own computation, but Namzu will not use
that late result to start a vector search or persist chunks after authority was
withdrawn. Custom vector stores should also pass the signal to their owned
transport; Namzu independently bounds its wait on their returned promise. The
original abort reason is rethrown.
