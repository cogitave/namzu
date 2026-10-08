---
type: Reference
title: CLI ACP live input
description: Connection-owned live operator text, bounded mailbox receipts and safe delegation wait release in the desktop ACP host.
resource: packages/cli/src/commands/acp.ts
tags: [cli, acp, desktop, messages, delegation]
---

# CLI ACP live input

`namzu acp --desktop` advertises `namzu/conversations/input/status` and
`namzu/conversations/input` when its runtime supplies both optional live-input
methods. These are CLI host extensions; embedded SDK ACP servers keep their
existing protocol. Core `session/prompt` still permits one active prompt per
session and rejects a second overlapping prompt.

| Method | Request | Result |
| --- | --- | --- |
| `namzu/conversations/input/status` | `{ sessionId, scopeId? }` | `{ available, scopeId?, inputs: [{ id, status }] }` |
| `namzu/conversations/input` | `{ sessionId, scopeId, inputId, prompt }` | `{ accepted: true, scopeId, inputId }` |

`scopeId` is an opaque token minted for one prompt. It is not a turn ID, session
ID or permission grant. The host checks the fresh project, tenant, application
home, trust and published session slot, then compares that read scope with the
runtime's admitted owner. The optional `CliSessionScope` argument on the runtime
methods is an internal trusted host handoff; the wire cannot supply it. Unknown
request keys are refused. The input method accepts operator text only; it cannot
change the active turn's model, effort, permission mode or attachments.

Availability belongs only to a current ordinary Namzu prompt on that connection.
An aborted or terminal prompt becomes unavailable before its asynchronous cleanup finishes.
Idle, replaced, foreign and obsolete owners cannot admit input. Pals do not
open this mailbox. The current native external-engine wrapper reports live input
unavailable and refuses submission; this describes Namzu's integration, not the
native engines' upstream capabilities.

## Admission and delivery

A mailbox accepts at most 20 distinct input IDs and 1,000,000 text characters
for the whole prompt, including already delivered entries. Repeating an ID with
the exact original text is idempotent while that scope is active and consumes
no extra capacity. Reusing it for different text is refused. Entries retain
arrival order. No input is automatically carried into the next prompt.

`pending` means admitted to the live mailbox; it is not a model response or
delivery claim. `delivered` means the query consumed it through `inboundMessages`
at a provider-valid boundary. Required tool results precede the new user message.
The usual query recorder then records that message; this status is not a separate
durable acknowledgement protocol. A live-input ACK acknowledges admission only.

The level-triggered `waitForInbound` callback wakes a delegated-task or
outstanding-work wait without draining its input. `wait_for_task` can return a
truthful still-running receipt, allowing the parent to read the operator message
while the same child continues. It does not cancel or restart that child and does
not interrupt arbitrary tools in flight. The model's next response remains model
behavior; admission does not guarantee a particular answer. See
[delegated work](delegated-work.md) and [query input](../sdk/query.md).

## Cancellation and uncertain acknowledgements

After a prompt closes, status for its exact scope retains `available: false`
and its pending/delivered IDs until the next prompt replaces that scope. The
closed mailbox refuses new submissions, including repeats. Clients retain their
original authored text separately and can reconcile a lost ACK against those
IDs before retrying or restoring an undelivered message. A different or obsolete
requested scope is refused rather than returning another prompt's receipts.

The mailbox and receipts are connection-local. Closing the connection removes
them; an unavailable transport does not prove that an input was rejected or
delivered. Hosts must preserve uncertain authored input and must not replay it
automatically. The ordinary next-turn queue remains separate. Explicit Stop
cancels the parent turn and its owned children; live input only releases a wait.
