---
type: Reference
title: Shared Pal input ledger
description: Durable Pal messages, allowlisted host observations and authenticated channel messages with one recipient claim barrier and exact original-log receipts.
resource: packages/sdk/src/pals/communication
tags: [sdk, pals, messages, activity, channels]
status: draft
---

# Shared Pal input ledger

`DiskPalCommunicationStore` implements both the existing Pal-only
`PalCommunicationStore` and additive `PalIngressStore`. Every input family uses
one recipient record, ordinal sequence, pending bound and unresolved-claim
barrier. No observation or channel creates another inbox.

## Source identity

| Intent | Source | Conversation route | Runtime provenance / receipt namespace |
| --- | --- | --- | --- |
| Existing Pal message | Captured Pal and sender conversation | Sender, sender conversation, recipient and dialog key | `peer-message` / `namzu-pal-message/1` |
| `PalObservationIntent` | Trusted host observation of an exact `PalActivityScope` | Subscription UUID, exact observed scope and recipient | `host-observation` / `namzu-pal-observation/1` |
| `PalChannelIntent` | Verified connection/native tuple and this event's actor | Provider, connection, external tenant, native conversation/channel/thread and recipient | `channel-message` / `namzu-pal-channel/1` |
| `PalOperatorIntent` | The owner's ordinary conversation, `{ kind: 'operator-conversation', tenantId, sessionId }`, captured by the host from the executing call | Recipient and that one operator conversation | `peer-message` (see below) / `namzu-pal-operator/1` |

An observation contains exactly one closed `PalActivityFact`, no arbitrary text
or private transcript. Its unique UUID `subscriptionTrail` contains the publisher
once. Hosts resolve prior lineage from original recorded deliveries; remote or
model-provided lineage is not evidence. Channel text is bounded to 32,000
characters. Native channel/thread IDs preserve `null` separately from strings.
A verified channel actor is captured per event, independently of its route.
Neither of those two sources impersonates a sending Pal or the operator.

An operator-conversation message is the one source that does speak for the owner,
and only for what the owner approved in that conversation. Its source carries a
tenant and a session ID and no Pal address, so it cannot be mistaken for a sending
Pal, and the model never supplies it: the tool reads it from the executing call.
`PalOperatorMessageBroker` (`@namzu/sdk`) accepts it with the intent kind
`operator` and an immutable ID over tenant, session and operation. It parses the
captured conversation strictly (extra fields, a Pal address, a non-session ID or a
foreign tenant are refused), refuses an unknown, paused or removed recipient, asks
the host's `authorize` for the `accept` phase, then publishes one route per
`(recipient, operator conversation)` into the same ledger and ordinal sequence as
every other family. Retrying a tool call reuses its operation ID; a changed body
under the same ID is refused. Acceptance is a receipt, never delivery or an
answer. Existing Pal rows, route hashes and receipt namespaces are unchanged, and
the legacy Pal-only readers do not see the new rows.

`ingressIntentId`, `ingressIntentDigest` and `ingressRouteId` construct stable
identities for trusted host composition. Observation IDs bind subscription,
observed scope and fact ID. Channel IDs bind the Namzu tenant, full native tuple
and provider event ID, excluding actor and recipient; changing either conflicts
with the original intent. Digests include source, destination and payload,
including observation lineage. Existing Pal IDs and digests are unchanged.
`ingressMessageRef` returns the source-specific namespace/ID/digest reference.
`ingressAuthorizationRequest(intent, phase)` produces the appropriate
payload view for a current host policy (`accept`, `deliver` or `wake`; existing
peer acceptance retains its `send` phase). Audit grant references are never
continuing consent or bearer credentials.

## Storage and compatibility

The generic methods are `readIngress`, `acceptIngress`, `routeIngress`,
`activateIngress`, `claimIngress`, `recordedIngress` and
`releaseUnrecordedIngress`. They are trusted host/store ports, not model tools.
The store validates identities and payloads; the host must supply current
acceptance authorization before calling `acceptIngress`.

Acceptance globally reserves one immutable source operation before atomically
publishing the recipient route and input. These are two recoverable commits;
retrying the same operation completes its original destination and profile.
Changed content or destination is refused even if recipient publication failed.
All input families count against `maxPending` (default 256), with no eviction.
Ordinals describe acceptance order. A busy conversation drains its own route;
this is not a promise of global execution FIFO across conversation routes.

Legacy methods retain Pal-only signatures and filtered views. Their private
writes use the full union, preserving hidden observation/channel rows. A hidden
non-Pal claim makes legacy `claim`/source throw `PalIngressBlockedError` instead
of repeatedly returning an empty intake. The legacy finite dispatcher reports
`idle: unresolved` before starting another conversation. Old custom Pal-only
store implementations remain supported without generic methods.

Recipient and operation storage schemas migrate version 1 records to version 2.
Old SDK binaries refuse version 2 records; do not run mixed SDK versions against
these paths. Existing Pal row shapes, route hashes and receipt namespaces stay
unchanged. Local process restart is supported; power-loss durability is not
claimed.

The public `RuntimeContextMessageKind` output union and
`RUNTIME_CONTEXT_MESSAGE_KINDS` catalogue add `host-observation` and
`channel-message`. This requires a major SDK upgrade: exhaustive consumers must
handle both new cases, preserving their untrusted source identity. The CLI labels
them Observed Pal activity and Message from a connected channel. The new kinds
are not operator messages, permission answers or steering instructions.

An operator-conversation delivery adds no runtime-context kind: it is recorded as
`peer-message` (a message from another conversation, which the CLI labels Message
from another session) so the public union is unchanged. Its rendered envelope names
`operator-conversation` as the source and states that it is untrusted runtime
context, not a tool approval, never an answer to a permission question and
without a reply channel back. The delivery reference uses the
`namzu-pal-operator/1` namespace, so a receipt for it cannot be replayed as a Pal
message.

## Query intake, dispatch and receipts

`createPalIngressInboxSource(PalIngressSourceOptions)` captures the exact route
binding and callback references at construction. It verifies the original Pal
root, tenant, project, control directory and pinned profile, checks current
`deliver` authority, and rechecks the current turn/writer fence after awaited
policy before claiming. Host-observation and channel text are untrusted runtime
context with explicit provenance; they cannot answer a permission question or
become steering. The envelope does not replace tool isolation or authorization.

`dispatchPalIngressOnce(options, recipient, signal)` is finite. It reconciles an
unresolved exact append first, then chooses the oldest pending input across all
families. Current `wake` authority is checked before opening/ensuring the owned
conversation and again before running it. Current `deliver` authority remains
required during intake. Hosts own the normal query and real Pal computer;
execution consent must also be checked before paid requests and tool effects.
No daemon, transport, schedule or virtual computer is silently created.

`reconcilePalIngressDelivery` recovers an interrupted acknowledgement from the
original journal, including entries removed from model history by compaction.
`verifyIngressRecorded` validates immutable source/payload identity and an exact
namespace, claim, session, turn, generation, rendered content and flushed head.
A `recorded` field from a custom store alone is not proof. Acknowledgement proves
transcript delivery, not successful inference or task completion.
Unknown append/stop outcomes retain their claim. Unrecorded release requires
complete verified original evidence and a fenced, stopped prior writer; elapsed
time cannot authorize reinjection.

See [activity observations](pal-activity.md), [channel ingress](pal-channels.md)
and [persistent Pals](pals.md) for source-specific host policies and computer
admission. Each input route keeps its own transcript; this API grants no sharing
of private conversation bodies and no Pal Team membership.
