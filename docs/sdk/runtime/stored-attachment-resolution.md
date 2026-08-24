---
uid: namzu.sdk.runtime.stored-attachment-resolution
title: Stored attachment resolution
description: Reference for resolving stored image and document references through SDK agent front doors, the finite materialization deadline, cancellation precedence, refusal semantics, and the explicit unbounded compatibility mode.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-24T00:00:00Z
lastReviewed: 2026-08-24
resource: packages/sdk/src/runtime/query/index.ts
tags: [sdk, runtime, attachments, stores, cancellation]
---

# Stored attachment resolution

A message may carry a `stored` attachment reference instead of inline base64.
The reference is opaque to the SDK: only the `AttachmentStore` that minted it
may turn it back into bytes. This avoids copying a large image or PDF into the
message before a run needs it.

`query()` resolves every stored reference once, before `RunContext` and the
provider request are created. A successful resolution becomes an ordinary
inline attachment in the canonical run messages. An unknown ref, missing
store, media-type mismatch, or timeout refuses the operation; the SDK never
drops the attachment and asks the model to answer an incomplete prompt.

## Reach the store from an agent

`runAgent()` accepts the store directly. Agent classes accept it on
`AgentInput`, because the store belongs to the messages for this invocation,
not to every future run of the agent.

```ts
import { createUserMessage, runAgent } from '@namzu/sdk'
import type { AttachmentStore, LLMProvider } from '@namzu/sdk'

declare const provider: LLMProvider
declare const attachmentStore: AttachmentStore

await runAgent({
  provider,
  model: 'model-id',
  attachmentStore,
  prompt: [
    createUserMessage('Read the contract.', [
      {
        type: 'stored',
        ref: 'attachment-ref-owned-by-the-store',
        kind: 'document',
        mediaType: 'application/pdf',
        name: 'contract.pdf',
      },
    ]),
  ],
})
```

`ReactiveAgent` and `SupervisorAgent` forward both `input.attachmentStore` and
their resolution policy to the same `query()` boundary. `RouterAgent` hands the
same input and config to its selected delegate. A pipeline step receives only
the developer-authored value produced by the previous step; it does not
materialize message attachments implicitly.

## Configure the phase deadline

The shipped default is `DEFAULT_ATTACHMENT_RESOLVE_TIMEOUT_MS`, currently
**60,000 ms (one minute)**. It applies to the complete parallel materialization
phase, not once per reference, so adding more attachments cannot multiply the
wall-clock wait.

Set `attachmentResolveTimeoutMs` on `QueryParams`, `runAgent()` options, an
agent config, or directory `agent.ts` config:

```ts
import { runAgent } from '@namzu/sdk'
import type { AttachmentStore, LLMProvider, Message } from '@namzu/sdk'

declare const provider: LLMProvider
declare const attachmentStore: AttachmentStore
declare const messages: Message[]

await runAgent({
  provider,
  model: 'model-id',
  prompt: messages,
  attachmentStore,
  attachmentResolveTimeoutMs: 15_000,
})
```

`resolveAttachment()` and `resolveAttachments()` expose the same policy as
`options.timeoutMs`. Integer values from `0` through the platform timer maximum
(`2,147,483,647`) are accepted. Negative, fractional, non-finite, and
over-range values are refused before store work.

Set the value to `0` only when another layer owns an equivalent bound. It
restores the earlier unbounded store wait while retaining caller cancellation.

## Cancellation and first-cause ownership

The materialization phase creates one private deadline controller and fuses it
with the caller's signal. Every `AttachmentStore.get()` receives the fused
signal, while the caller's controller is never aborted by the SDK.

The first cause wins:

- A pre-aborted caller starts no store work.
- Caller cancellation that wins the race retains its exact reason and follows
  the run's normal cancelled-result path.
- Deadline expiry aborts only the fused store signal and rejects with
  `AttachmentResolutionTimeoutError`.
- A custom store that ignores its signal still cannot hold the SDK promise;
  the SDK races the store wait itself and ignores late settlement.

The timer is disarmed after success or failure. One failed reference refuses
the complete batch, so the provider never receives a partially resolved
conversation.
