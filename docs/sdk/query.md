---
type: Reference
title: Query input and durable delivery
description: Ordinary query input, optional durable host delivery, exact session-log acknowledgement and asynchronous settle waits.
resource: packages/sdk/src/runtime/query/
tags: [sdk, query, messages, persistence]
generated: { by: "codex/gpt-6", at: "2026-10-02" }
---

# Query input and durable delivery

`query` streams session events and returns the completed turn. `drainQuery`
consumes those events and returns the turn directly; its optional listener
receives each event in order. Both require the host's session, topic, project
and tenant identity. [Run the kernel](quick-start.md) describes the simpler
`runAgent` entry point and its generated identity defaults.

## Input channels

| Input | When it enters the transcript | Acknowledgement |
| --- | --- | --- |
| `messages` | Seeded or restored before the turn's first request | Ordinary session recording |
| `inboundMessages()` | Drained at complete assistant/tool boundaries | Existing synchronous host queue; no durable delivery receipt |
| `durableInbound` | Initially before inference, then at the same complete boundaries | Normal message append, awaited recorder flush, then awaited exact host acknowledgement |
| `waitForInbound(signal)` | Wakes an existing outstanding-work hold | Wake only; input still comes from a drain |

All channels are optional except initial `messages`. Adding a durable source
does not change hosts that use the existing queue or hold callbacks.

## Answering while a call runs

A tool call that runs for a long time used to hold the operator's message until
it finished. `QueryParams.answerWhileCallsRun` (default off, and ignored without
`waitForOperator`) changes that. `waitForOperator(signal)` resolves when the
operator wrote and for no other reason, so a child's notice or a peer's mail,
which also wake `waitForInbound`, never hands a call back. When it
fires during a tool batch and the batch has run for two seconds, each call not
yet finished is answered with a placeholder result saying it is still running
(or, for a call queued behind an earlier one that has not begun, that it has not
started yet),
was not interrupted, must not be repeated or polled for, and cannot be stopped
from the model's side. The model reads the operator's message and replies at
once. The calls keep running in the same batch; each real result reaches the
model later as a message that names the call id, whether it succeeded or failed.
A turn whose model has nothing more to say is held open for such a call, bounded
by the turn's remaining time, the way it is for a delegated task. `waitForOperator` is
consulted during batches, so it must have no side effects. A batch under per-call review is not
detached, because it may be waiting on a person. Code:
`packages/sdk/src/runtime/query/detached-calls.ts`.

## Durable source contract

`QueryParams.durableInbound`, `RunAgentOptions.durableInbound` and
`BaseAgentConfig.durableInbound` accept `DurableInboundSource`. `QueryAgent`
and the example supervisor forward the source to their own query invocation.
It is bound to that session, rather than inherited by delegated children.
An explicit `sessionLog` is required. An explicitly supplied
`InMemorySessionLog` is supported for tests and volatile hosts; it loses
records when its process exits and provides no restart durability.

A source implements:

- `claim({ sessionId, turnId, signal })`: return claimed `DurableInboundMessage`s with
  a stable `claimId` and `InboundDeliveryRef`. Each message requires a validated
  `runtime-context` source with an exactly matching `deliveryRef`.
- `recorded(receipts)`: verify and persist the exact records before resolving.
- Optional `wait(signal)`: wake an existing hold when input may be ready. It
  must remove its listener when the supplied signal is aborted.

Each reference has `namespace`, `id` and `digest`: nonempty strings of at most
512 characters without ASCII control characters. `isInboundDeliveryRef`
validates this generic shape; a host must impose its own namespace and digest
semantics. A runtime context source may carry optional `deliveryRef`. Its
reference is validated on durable message admission and in the session-record
schema. If present, it must match the claim exactly.

The kernel snapshots incoming claims and strips a preexisting message ID. It
appends each message through the ordinary recorder, keeping its root object
mutable so the recorder can stamp the actual record ID. It then awaits the
write queue and supplies an `InboundDeliveryReceipt` containing:

- the exact claim and delivery reference;
- this writer's session and turn IDs;
- the actual recorded message ID;
- `through`, the verified log-head pointer, generation and byte position after
  the append chain completed.

The kernel checks that its writer still owns the active turn before claiming,
writing and acknowledging. It awaits `recorded` before any subsequent model
request. Claim, append, flush, acknowledgement, stale-writer and cancellation
failures prevent further inference. A normal runtime failure is reported on
the failed turn; failures that prevent recording a terminal state can reject
the query promise.

## Authority and placement

The source is a trusted host port. Its existence is not authorization to
receive a message, wake a recipient or execute work. Hosts enforce current
disclosure, recipient policy, admission and conversation ownership separately.
`recorded` must verify original session-log records rather than model text or
compacted summaries.

This port accepts host context only. Plain operator messages, project
instructions, operator steering and context without an exact reference are refused before
recording or acknowledgement. Use `source: { type: 'runtime-context', kind, deliveryRef }`.
The required provider `user` role does not make that message an operator task,
tool approval or standing instruction. A peer context does not replace the
current operator task or reset skill grants.

Fresh input is appended and acknowledged before input guardrails inspect the
turn. While a turn is busy, delivery waits until a complete assistant response
or tool batch; it never splits an assistant tool call from its required tool
results. Resuming a pending reviewed tool batch applies its results before
draining durable arrivals. Guardrails on such a resumed batch inspect its
existing input before the pending tools execute, as they do for the legacy
queue.

## Wake, cancellation and recovery

`wait` joins the existing hold for an outstanding delegated task or explicitly
awaited background job. A durable source alone does not keep a finished turn
open indefinitely. Durable and legacy input waits share the hold's disposable
signal: finishing, cancellation or another arrival aborts losing listeners.
Input is then claimed, recorded and acknowledged through the normal boundary.

If the process stops after append but before acknowledgement, the host's next
claim must reconcile that exact original record and persist its receipt. If a
prior claim was never appended, only host-controlled fencing and recovery may
release it. The kernel does not silently skip transient messages, trust an
already supplied ID or re-execute a former model turn to manufacture a receipt.
The source owns deduplication and must never claim an accepted delivery again. [Pal messaging](pals.md) composes the same port
with persisted recipient routes and explicit consent.
