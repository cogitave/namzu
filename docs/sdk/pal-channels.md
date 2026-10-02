---
type: Reference
title: Authenticated Pal channel ingress
description: Host-verified channel identities, immutable native routes, durable inbox delivery and recorded response/action routing.
resource: packages/sdk/src/pals/channels
tags: [sdk, pals, channels, authorization]
status: draft
---

# Authenticated Pal channel ingress

`PalChannelIngress` accepts channel events through a required trusted
`PalChannelVerifier`. The host captures `PalChannelConnection` before receiving
input: its Namzu `tenantId`, `provider`, `connectionId` and expected
`externalTenantId`. Credentials stay inside the verifier's private closure.
Raw input cannot choose a credential, connection, Namzu tenant or Pal.

The verifier authenticates each event and returns the current `actorId` and
`eventId`, external tenant, native conversation, nullable native channel and
nullable native thread. First-participant identity is never continuing
authority for later events. Only new `kind: 'message'` events with bounded text
enter this port. Edits, service notifications and attachments have no implicit
message conversion.

```ts
import {
  DiskPalChannelRoutes, DiskPalCommunicationStore, PalChannelIngress,
  type PalChannelIngressOptions, type PalStore,
} from '@namzu/sdk'

declare const pals: PalStore
declare const connection: PalChannelIngressOptions['connection']
declare const verify: PalChannelIngressOptions['verify']
declare const selectRecipient: PalChannelIngressOptions['selectRecipient']
declare const authorize: PalChannelIngressOptions['authorize']

const ingress = new PalChannelIngress({
  pals, connection, verify, selectRecipient, authorize,
  routes: new DiskPalChannelRoutes({ root: '/private/channel-routes' }),
  store: new DiskPalCommunicationStore({ root: '/private/pal-inbox' }),
})
declare const authenticatedTransportInput: unknown
const accepted = await ingress.accept(authenticatedTransportInput)
console.log(accepted.status) // acceptance, not model execution or a remote reply
```

## Exact routing and durable input

`DiskPalChannelRoutes({ root, secureDirectory? })` publishes one immutable target
decision per Namzu tenant and complete native tuple. The tuple includes provider,
connection, external tenant, native conversation, channel and thread. Null stays
different from a string. A native identifier that happens to look like a Namzu
session UUID is still a native identifier; channel ingress never calls
`resolveExternalSession` or opens that UUID's transcript.

The first authorized route selects a Pal and pins its current profile revision.
Future events use that target even after selector defaults, names or model
preferences change. A concurrent conflicting target receives
`PalChannelRouteConflictError`. This registry stores a routing decision only;
the shared `PalIngressStore` owns the actual conversation, recipient queue,
writer claim and delivery receipt. Acceptance reconciles the actual shared
binding and refuses a different profile revision.

The event operation identity excludes its actor and target; immutable content
includes both. An identical event retry returns its original acceptance. A
changed actor, body or target under the same event identity is refused. Current
`accept` authorization is required before routing publication and is checked
again after that awaited publication before queue acceptance. Its saved grant
reference is audit evidence, not future consent. A paused Pal may receive queued
input; pause still blocks execution.

`createPalIngressInboxSource` and `dispatchPalIngressOnce` use the same recipient
ledger as Pal messages and host observations. One unresolved claim blocks other
input families. Current `deliver` and `wake` authorization are separate checks;
there is no permissive default. The host must keep current execution authority
at each paid request and tool effect. Input is untrusted `channel-message`
runtime context, with the exact `namzu-pal-channel/1` delivery reference. It does
not become operator steering, an approval or a remembered tool grant.

Normal message append, awaited flush, and exact original-log verification occur
before delivery acknowledgement and paid inference. Recovery uses retained
original records, including after compaction. A receipt proves recording, not
successful subsequent model or tool work.

## Responses and native actions

`PalChannelRouter.replyRoute(ref, context, signal?)` requires an exact recorded
channel reference, owned Pal conversation and pinned revision. It verifies the
original log receipt and reads current reply authorization. The returned
`PalChannelResolvedRoute` contains the original full native identity, triggering
actor, current actor, owned context and `recordedReceipt`. The caller cannot
substitute the last participant, another channel or an arbitrary destination.
No remote send transport or response outbox is included; route resolution is
not a delivery acknowledgement or an exactly-once remote-send claim.

`actionRoute(raw, context, signal?)` authenticates the action's current actor
independently. The verifier must cover its delivery reference, action/event IDs
and exact serialized JSON `payload`; the SDK checks its SHA256 `payloadDigest`.
The native tuple must match the recorded triggering delivery. Current action
authorization is separate from read, receive, wake and reply authority.

`executeAction` refuses execution unless a trusted `PalChannelActionPort` was
provided. That port must validate the supported native action schema, match the
exact pending request/checkpoint and triggering turn, check current consent and
pause, durably consume the action once, and confirm the actual native result.
It must retain uncertain effects for reconciliation. No model text or channel
receipt can manufacture a checkpoint, resume a parked turn, or approve all tools.

The shipped CLI bridge currently supports exact `tool_review` answers
`approve_once` and `reject` through its native parked-review gate. Other action
kinds are unsupported. Provider authentication, actor authorization, native
request proof and effect confirmation are four distinct checks.
