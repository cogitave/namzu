---
uid: namzu.sdk.integrations.a2a-client
title: A2A client discovery and delegation bounds
description: Reference for finite A2A agent-card discovery, whole-delegation deadlines, cancellation ownership, remote task cleanup, polling validation, and the unavoidable pre-task-id uncertainty window.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-19T00:00:00Z
lastReviewed: 2026-08-19
resource: packages/sdk/src/bridge/a2a/client.ts
tags: [sdk, bridge, a2a, timeout, cancellation]
---

# A2A client discovery and delegation bounds

`fetchAgentCard` and `A2ADelegate` are the client half of Namzu's A2A
bridge. Both own finite waits even when the injected `FetchLike` accepts an
`AbortSignal` and then ignores it.

## Discovering a peer

`fetchAgentCard(baseUrl, options)` applies one deadline to the fetch handshake
and the JSON response-body read. The default is **30,000 ms**. Set
`options.timeoutMs` to an integer from `1` through the platform timer maximum
(`2,147,483,647`) to choose another bound. `timeoutMs: 0` explicitly restores
the former unbounded behavior.

A signal that is already aborted starts no request. A later caller abort closes
only the private transport signal and rejects with the caller's exact reason.
A deadline rejects with an error named `TimeoutError` and uses that same object
as the private transport's abort reason. If a custom fetch turns every transport
close into a generic `AbortError`, that transport error does not replace the
cause that won the operation.

## Dispatching work

`A2ADelegateConfig.timeoutMs` defaults to **600,000 ms** and bounds the whole
delegation, starting before `message/send`. It therefore includes task creation,
every polling delay, each `tasks/get` request, and every response-body read. A
configured value must be a positive integer no greater than
`2,147,483,647`.

`pollIntervalMs` defaults to **1,000 ms** and has the same positive-integer
range. Invalid timer values are refused when the delegate is constructed,
before a prompt reaches the peer.

```ts
import {
  A2ADelegate,
  DelegatingTaskScheduler,
  fetchAgentCard,
} from '@namzu/sdk'

const peerFetch = (input: string, init?: Parameters<typeof fetch>[1]) =>
  globalThis.fetch(input, init)

const card = await fetchAgentCard('https://peer.example', {
  fetch: peerFetch,
  timeoutMs: 15_000,
})

const delegate = new A2ADelegate({
  id: 'analyst',
  card,
  fetch: peerFetch,
  pollIntervalMs: 500,
  timeoutMs: 120_000,
})

const scheduler = new DelegatingTaskScheduler({ delegates: [delegate] })
```

## What cancellation proves

A `DelegateResult` with `status: 'cancelled'` says the parent stopped waiting.
It does not claim that the peer confirmed cancellation.

Once `message/send` has returned a non-empty task id, caller cancellation or a
deadline aborts any pending poll and sends exactly one best-effort
`tasks/cancel`. That cleanup request owns a separate 500 ms bound, so an
unreachable cancellation endpoint cannot create a second hang.

Every `tasks/get` reply must carry the id returned by `message/send`. A peer
that answers a poll for task A with task B is refused; B's artifacts never
become A's result, and the client makes the same bounded cleanup attempt for A.
HTTP, body, JSON-RPC, or task-schema failures after an addressable non-terminal
task is known also attempt that cleanup before the original error is rethrown.
`input-required` is terminal for this delegate because it has no channel to
answer the peer, but it is not terminal on the peer. Namzu therefore returns
the existing explanatory failure only after the same bounded cleanup attempt.

Before the peer returns a task id, the protocol gives the client no address for
`tasks/cancel`. Aborting `message/send` immediately can therefore abandon work
that the peer created but whose id never crossed the response boundary. Namzu
gives the in-flight request a bounded 500 ms cleanup grace. If a reply arrives,
even with malformed status or artifact fields, a non-empty string id is retained
only for `tasks/cancel`; the malformed task is never accepted as an answer. If
no safe id arrives, the private transport is aborted and a deadline result says
that the remote outcome is unknown.

An injected fetch that ignores its signal may continue its own I/O after Namzu
settles. The SDK cannot close transport it does not own. It does keep that late
promise observed, does not advance the scheduler from its result, and does not
leave `waitForTask` blocked on it.
