---
type: Design
title: Resident communication experiment
description: Atomic outgoing intents, acknowledged delivery and explicit delivery windows for resident agents.
resource: packages/sdk/src/manager/resident
tags: [sdk, agents, continuity, delivery]
status: draft
---

# Resident communication experiment

This implements the communication stage of the [resident roadmap](resident-agents.md).
An authorized host can retain a finding and its outgoing message together,
deliver it later without another user prompt, and distinguish destination
acceptance from an uncertain send. It supplies no external account, notification
channel, CLI default, background service or permission to contact someone.

## Design evidence

The [transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
puts business state and outgoing intent in the same transaction. Namzu applies
that pattern to pursuit settlement and its message in one agenda revision.
Generating a message after separately committing completion would leave a crash
gap. A dispatcher later handles the remote operation separately.

[Temporal's idempotency explanation](https://temporal.io/blog/idempotency-and-durable-execution)
motivates keeping one operation ID across attempts: a timeout can hide an effect
which already happened. Namzu retains uncertain delivery instead of interpreting
every exception as proof that retrying is safe. This is a conservative local
protocol, not a claim to implement Temporal's distributed execution guarantees.

[OpenClaw's heartbeat contract](https://github.com/openclaw/openclaw/blob/227e7ae26af4e4f3f8a256c4fa808c7b046f4c88/docs/gateway/heartbeat.md)
distinguishes generated but unconfirmed notifications from sent notifications
and uses explicit time zones for active hours. Our separate persistent outbox
and allowed delivery window are adaptations, not that implementation's API.

## Atomic intent and host integration

`ResidentHostOptions.prepareMessage?: ResidentMessageFactory` runs after the
developer step and optional observer. It receives the admitted pursuit, decision
and cancellation signal, returning a host-validated `ResidentMessageInput` or
`null` for silence. The host checks content, relevance, recipient authorization
and disclosure before returning a message. The kernel does not infer permission
from a model's suggested recipient or from the existence of an account.

`DiskResidentAgenda.settleWithMessage(id, claim, decision, message, now,
observation?)` atomically persists pursuit disposition, optional measured
feedback, and the outgoing intent. Its `pursuitId` must match the settling
pursuit. Failure or a full outbox leaves the admitted pursuit unresolved and
does not save partial completion. The transport is not called inside this
transaction. Custom agenda stores can implement the optional method; enabling
`prepareMessage` without this support is rejected at construction.

`enqueueMessage(snapshot, input)` separately records a host-authorized intent
for an existing pursuit, using the exact agenda revision. Do not use this after
separate settlement when both facts must commit together. A standalone enqueue
has a null source claim; atomic settlement records the original pursuit claim.

`ResidentMessageInput` contains a UUID `id`, UUID `pursuitId`, opaque
`destination` route, `body` up to 8,000 characters, and an epoch-millisecond
`notBefore`. The body is preserved; route labels are trimmed and bounded to 256
characters. Credentials and connection configuration belong in the host's
transport, not this record. Reuse the same ID only for the same immutable intent
and source claim. A matching enqueue returns the retained message; a conflicting
payload is refused. Deduplication is by stable identity, not semantic similarity.

`ResidentAgendaState.outbox` is an optional immutable list of at most 128
intents. Acknowledged and cancelled entries remain in that bound to retain
deduplication evidence. Explicit [archival](resident-retention.md) can free
active slots while retaining those records in immutable history. Physical
garbage collection is not implemented. Schema 3 introduced communication;
schema 4 adds archival and learning. Schemas 1 and 2 read without invented
messages; subsequent writes use schema 4. Older writers refuse the
new schema rather than dropping its delivery state.

## Delivery and recovery

`ResidentOutboxStore` exposes `read`, `claimMessage` and `settleMessage`.
`DiskResidentAgenda` implements it. At most one message may be `sending` for an
agenda, including across processes claiming different messages. Pursuit work
and delivery have separate admission slots; they may overlap. Neither grants
the other additional execution authority.

`deliverResidentMessage(store, transport, { signal, gate, now? })` admits at
most one transport call and returns `ResidentDeliveryResult`. It starts no
timer and makes no model calls. Pending entries are ordered by next attempt
time and then UUID; this is not causal FIFO or a general event log. A gated
destination does not prevent another due destination from being considered.

The required synchronous `ResidentDeliveryGate` returns `{ allow: true }` or
`{ allow: false, nextCheckAt, reason }`. A finite next check must be in the
future; null means no known automatic opening. The gate runs before claiming
and again immediately before sending. The driver also rereads pause and claim
state after admission. No transport starts if the window closed or the agenda
was paused during admission; that known unstarted attempt can safely return to
pending. A denial before admission changes no durable state.

The driver returns `idle` with `paused`, `unresolved`, `empty`, `not-due`,
`window` or `contended`, and an available `nextCheckAt`. The application decides
when to invoke it again. Pausing does not remotely interrupt an already-entered
transport. The application must abort its delivery signal and await it draining;
an uncooperative callback cannot be forcibly stopped by this SDK function.

`ResidentOutboxMessage` preserves its immutable input and source scope, plus its
revision, attempt count, delivery claim, next attempt time, receipt and last
non-acceptance reason. Attempts count durable claims, including an admitted
attempt whose transport was never entered. A host transport uses `message.id`
as the stable receiver idempotency key; each admission gets a fresh `claimId`.

The `ResidentMessageTransport` callback returns a `ResidentDeliveryOutcome`:

| Outcome | Durable result | Required evidence |
| --- | --- | --- |
| `acknowledged`, `receiptId` | `acknowledged`, receipt and acknowledgment time | The authorized destination accepted this message |
| `not-accepted`, future `retryAt`, `reason` | `pending` with the same message ID | This attempt did not accept the message |
| `not-accepted`, null `retryAt`, `reason` | terminal `cancelled` | Non-acceptance with no further attempt intended |
| Exception, invalid outcome or cancellation | stays `sending` | Acceptance is not established either way |

A generic HTTP error is not automatically non-acceptance. An adapter must
understand its destination contract; a receipt here proves acceptance, not human
reading, notification display, or downstream processing. The receipt is provided
by trusted host code and is not independently verified by the kernel.

An unresolved claim has no expiry or automatic takeover and blocks new delivery
for the whole agenda. Stop old executors, inspect the destination's effect or
receipt, and explicitly call `settleMessage(exactClaim, outcome, now)` to
reconcile. Acknowledgment commits are fenced by message revision and claim;
unrelated agenda contention retries persistence, never the transport. Fencing
storage does not undo remote effects or stop a still-running sender. This does
not promise exactly-once external delivery, eventual delivery without host
intervention, or durability across power loss. The underlying trusted local
filesystem requires exclusive hard-link publication and retains old revisions.

## Daily allowed window

`createResidentDeliveryWindow(ResidentDeliveryWindowConfig)` returns a gate.
Specify a named `timeZone`, an inclusive `startMinute` and exclusive `endMinute`
in local minutes from midnight (0–1439). End before start means overnight; equal
boundaries are rejected. For unrestricted times use a gate returning allow,
while still checking destination authorization in host code.

The helper checks actual instants in the named zone and searches future UTC
minute boundaries for at most 72 hours. DST gaps skip nonexistent local times;
folds can admit both occurrences. No opening within that horizon and the Date
range returns null. Historic offsets containing seconds can conservatively
defer an opening by less than one minute. It does not infer the server's zone,
schedule its own timer, or implement holidays, weekly calendars or rate limits.

```ts
import {
  createResidentDeliveryWindow, deliverResidentMessage,
  type ResidentMessageTransport, type ResidentOutboxStore,
} from '@namzu/sdk'

async function deliverDuringWorkingHours(
  store: ResidentOutboxStore,
  authorizedTransport: ResidentMessageTransport,
  signal: AbortSignal,
) {
  const gate = createResidentDeliveryWindow({
    timeZone: 'Europe/Istanbul', startMinute: 9 * 60, endMinute: 18 * 60,
  })
  return deliverResidentMessage(store, authorizedTransport, { signal, gate })
}
```

## Reproducible experiment

After building the SDK:

```bash
pnpm --filter @namzu/sdk test -- src/manager/resident
pnpm --filter @namzu/sdk test:proc -- src/manager/resident
node research/resident/outbox.mjs
```

The script uses a real HTTP server on `127.0.0.1`, synthetic messages and a
controlled clock. Refusal before connection is recorded as non-acceptance;
reopening and reconnecting permits one scheduled retry. A second request is
accepted by the fixture but its socket closes before the acknowledgment reaches
the sender. Reopening preserves uncertainty and makes no additional send; an
inspected fixture receipt permits explicit reconciliation. A closed delivery
window produces zero transport calls.

The observed run made three transport calls, two received HTTP requests and two
fixture acceptances, with zero model calls. Evidence is retained in
`research/resident/results/2026-09-11-outbox.json`. A separate process test races
two actual senders, kills the winner after one fixture effect but before its
acknowledgment commit, and verifies no automatic replay and stale-claim refusal.
This tests delivery state and process failure, not a real messaging service,
live model reasoning, end-user TUI behavior or recipient consent UI.
