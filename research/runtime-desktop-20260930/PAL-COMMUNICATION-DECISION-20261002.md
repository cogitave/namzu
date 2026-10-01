# Decision: durable Pal messages and authorized conversation routes

Date: 2026-10-02. Status: implementation proposal awaiting review. The interfaces
and files proposed below are not shipped exports. This decision follows the
[pinned communication source audit](PAL-COMMUNICATION-CHANNELS-20261002.md) and
the current SDK/CLI/desktop Pal implementation in the schedule-ownership
worktree. No upstream SDK dependency is proposed.

## Decision

A Pal receives messages at a stable **Pal address**. A **route binding** selects
one owned conversation and its immutable Pal profile revision. A durable
**inbox** retains accepted messages until the existing session writer records
them. An explicit host connects this inbox to running or idle SDK queries.

Use one SDK communication store for route bindings and incoming intents, with
one revision transaction per recipient Pal. Reuse the existing revision-store
publication, session writer lease, message records, sequence/generation replay,
runtime-context rendering, and current Pal computer admission. The host supplies
identity, grants, conversation creation, and wake policy. The store starts no
model turn, transport, background service, or virtual computer.

Existing cross-session peers remain a separate live-session capability. A
ResidentAgenda pursuit remains an actual authorized pursuit; receiving a chat
message must not create a dummy pursuit. A Pal Team and its coordinator are a
later organizational feature. Microsoft Teams is an external channel provider.

## Evidence behind the boundary

| Current source | Established behavior | Consequence |
| --- | --- | --- |
| [Query input](../../packages/sdk/src/runtime/query/index.ts) and [iteration delivery](../../packages/sdk/src/runtime/query/iteration/index.ts) | `inboundMessages` drains synchronously at provider-valid boundaries; `waitForInbound` only wakes a wait | Add an optional durable source at these same boundaries; retain existing input behavior |
| [Turn recorder](../../packages/sdk/src/manager/session/turn-recorder.ts) | `pushMessage` queues an append; `flush` awaits it; passing `messageId` means already recorded and skips the append | A drained callback cannot itself acknowledge durable delivery; append normally and await the writer before acknowledgement |
| [Session log](../../packages/sdk/src/store/session-log/core.ts) and [records](../../packages/sdk/src/types/session/records.ts) | Writer fencing, verified hash chain, message provenance, record pointers, generation and active-turn state already exist | Reconcile incoming intent against this log; do not create another turn/event log |
| [Revision store](../../packages/sdk/src/store/kv/revision-record-store.ts) | Immutable exclusive next-revision publication and domain conflict checks across store instances | Route first claim, deduplication, and exact inbox claims can share this transaction primitive |
| [CLI Pal membership](../../packages/cli/src/pals/conversations.ts) | First-record ownership pins Pal ID/revision and exact tenant/project/control cwd; empty conversations survive restart | A route must validate this ownership before reading history, settings, or starting a query |
| [Pal runtime](../../packages/sdk/src/pals/runtime.ts) | Current pause and owned computer/controller checks; pinned profile may differ from current definition | Current execution authority is checked separately from immutable conversation context |
| [Resident communication](../../packages/sdk/src/manager/resident/outbox.ts) | Persisted exact send claims; uncertain outcomes remain unresolved; acceptance is separate from model success | Adapt this discipline for inbox delivery, without copying pursuit state or implementing another outbound dispatcher |
| [CLI peer runtime](../../packages/cli/src/integrations/peers/runtime.ts) | Process-owned bounded pending queue and deduplication; enqueue acceptance is not model delivery | Do not advertise this existing queue as durable Pal mail |
| [External refs](../../packages/sdk/src/store/session-index/refs.ts) | Origin/external references support discovery | A projected reference does not replace exclusive route admission or actor authorization |

Disk revision publication currently does not fsync every incoming commit. The
session log defaults to syncing lifecycle/checkpoint boundaries, not every
message record. The first implementation may claim **process-restart recovery
on the supported local filesystem**, not protection from power loss. Stronger
durability requires explicitly strengthening the shared storage primitive and
session append policy, with tests; duplicating their writers would be wrong.

## Identity, routes, privacy, and authority

### Address and route keys

`PalAddress = { tenantId, palId }`. The embedding host supplies the Namzu tenant;
the model cannot select it. Display names, live TUI session IDs, native provider
actor IDs, and computer IDs are not Pal addresses.

Use a discriminated structured key, versioned as `v: 1`:

- `kind: 'pal'`: Namzu tenant, captured sender Pal ID and sender conversation ID,
  recipient Pal ID, and host-selected dialog key. One sender conversation can
  open an explicitly authorized conversation with another Pal.
- `kind: 'channel'`: Namzu tenant, provider, connection ID, external tenant ID,
  native conversation ID, and nullable native channel/thread IDs. The host's
  connection identifies the credential/installation scope. Provider-native
  conversation IDs are preserved rather than replaced with guessed thread IDs.

Encode fixed-position JSON tuples and hash them to lowercase SHA-256 for path
segments. Preserve and compare the complete tuple in the record, so delimiters,
case-insensitive Windows paths, empty/null fields, and a digest collision cannot
silently join routes. Refuse path aliases/symlinks and apply the host's existing
private-directory policy. A hash is a filename, not an authorization decision.

### Route binding lifecycle

The first accepted intent atomically reserves a route with a generated
conversation ID and the recipient's selected profile revision. The reservation
and intent commit together. A trusted host then ensures the claimed root session
exists with that exact Pal, revision, tenant, project, and control cwd, and
activates the binding under its exact revision. It must be idempotent: an empty
valid claim is sufficient, and a crash cannot replace its conversation ID.

`reserved -> active`; an invalid owner/profile produces `blocked`, retaining
the original identity and reason for explicit repair. No fallback to an ordinary
host conversation or another Pal. After activation the Pal/conversation/profile
tuple is immutable. Redirection creates a new explicit route generation; it
never silently migrates a private transcript.

The current CLI `claimPalConversation` is idempotent for valid existing claims
but creates a new claim from the **current** profile and rejects a paused Pal.
The host port therefore needs creation at an explicitly supplied revision and
membership verification shared with this existing helper. This is a concrete
integration change, not an SDK capability that already exists. A reserved route
accepted while paused can wait; waking it must not choose a newer profile.

### Grants and sender context

The host constructs a `PalMessageSender` for a validated current source
conversation. Model-visible arguments contain recipient Pal, body, and an
optional opaque reply reference. They cannot supply the sender identity, tenant,
source conversation, transport credential, arbitrary recipient conversation, or
approval status. External ingress receives an equivalent sender only after
provider authentication and current actor resolution.

Acceptance requires both permission to send/disclose from the source and
permission to receive on the destination. Wake, reply, activity observation,
and approval are separate permissions. Before dispatch, recheck current route
and actor policy, Pal pause, and actual computer admission. Persist the grant
reference/revision that authorized acceptance for audit; it is not permanent
authority. Revocation blocks pending execution. Retention and removal of
previously disclosed context require a separate explicit privacy policy.

Each route has its own transcript. Share only the explicit message body and
small declared metadata. No implicit sharing of history, learned private memory,
files, browser accounts, screenshots, or host credentials. A reply reference
resolves the original authorized sender conversation; it is validated against
that envelope and current grants, not accepted as a caller-supplied session ID.

## Incoming intent and delivery state

An immutable envelope contains `v`, stable `id`, complete source identity,
recipient address, route key/binding revision, body, optional `replyTo`, creation
time, and authorization evidence. Credentials and bearer action tokens do not
appear in it. An event ID is scoped by connection/source identity; retries retain
that ID. The same identity with a changed body/recipient/route is a conflict.

The acceptance receipt means the route reservation and incoming intent have
committed. It does not mean a model read it, responded, completed work, or that a
remote transport displayed a reply. Pending intents are ordered by committed
recipient inbox ordinal, not caller timestamps. Deduplication evidence must
survive archival; pending work is never silently evicted. Pending limits are
explicit host resource policy, with an admission error, rather than a token cap.

| State | Meaning | Allowed next step |
| --- | --- | --- |
| `pending` | Durable acceptance; no session append has been acknowledged | Current grant check and exact route/turn claim |
| `claimed` | One exact claimant owns a candidate delivery; claim records route, session, turn, writer generation and claim ID | Normal message append, awaited writer receipt, exact acknowledgement |
| `recorded` | A matching runtime-context message exists in the verified owned session log | Observe existing turn outcome; do not inject again |
| `refused` | An explicit policy decision closes an unrecorded intent with reason | Retain deduplication/audit evidence |

One recipient has at most one outstanding delivery claim across processes. A
claim has no expiry-based retry: an expired clock does not prove a writer or
tool effect stopped. A safe pre-append abort may return to `pending` only with
proof that no record or live writer can still append. Unknown outcomes remain
`claimed` and appear as recovery required.

| Recovery evidence | Required result |
| --- | --- |
| Verified owned log contains matching delivery reference, message digest and route claim | Acknowledge `recorded` with actual message ID and a covering log pointer; never reinject |
| Verified complete log has no matching message; previous writer is fenced and the corresponding turn is known stopped | Exact-claim release to `pending` is permissible |
| Incomplete/torn/unverified log, live writer, unknown owner, or uncertain stop | Retain unresolved claim; do not infer non-delivery |
| Matching record exists but its turn is interrupted/failed | Message remains `recorded`; expose existing turn status; no automatic repetition of tool effects |

Recovery scans verified original `message` records, including spilled bodies.
Folded current history is insufficient: compaction can remove a message from
the model context without removing its original delivery evidence. A cache
may accelerate lookup only when validated against the log head/generation.

## Proposed SDK API

Names below are a concrete additive contract sketch. Use existing branded
session/turn/message IDs and `SessionLogHead` in the actual declarations.

```ts sketch
interface InboundDeliveryRef {
  readonly namespace: string;
  readonly id: string;
  readonly digest: string;
}

interface InboundDeliveryClaim {
  readonly claimId: string;
  readonly ref: InboundDeliveryRef;
  readonly message: UserMessage; // validated runtime-context, never operator steering
}

interface InboundDeliveryReceipt {
  readonly claimId: string;
  readonly ref: InboundDeliveryRef;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly messageId: MessageId;
  readonly through: SessionLogHead; // verified head covering the appended message
}

interface DurableInboundSource {
  claim(context: {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
    readonly signal: AbortSignal;
  }): Promise<readonly InboundDeliveryClaim[]>;
  recorded(receipts: readonly InboundDeliveryReceipt[]): Promise<void>;
  wait?(signal: AbortSignal): Promise<void>;
}

interface PalCommunicationStore {
  accept(intent: AuthorizedPalMessage): Promise<PalMessageReceipt>;
  route(key: PalRouteKey): Promise<PalRouteBinding | null>;
  activate(binding: PalRouteBinding, proof: PalConversationProof): Promise<PalRouteBinding>;
  pending(recipient: PalAddress): Promise<readonly PalInboxMessage[]>;
  claim(request: PalDeliveryClaimRequest): Promise<PalInboxClaim | null>;
  recorded(claim: PalInboxClaim, receipt: InboundDeliveryReceipt): Promise<PalInboxMessage>;
  reconcile(claim: PalInboxClaim, evidence: PalDeliveryEvidence): Promise<PalInboxMessage>;
}

interface PalMessageHostPort {
  ensureConversation(binding: PalRouteBinding, signal: AbortSignal): Promise<PalConversationProof>;
  // Notification is a scheduling hint, never the durable acceptance/recorded acknowledgement.
  notify(recipient: PalAddress): void;
  // Host drives at most one ordinary SDK query under current grants and Pal admission.
  runConversation(binding: PalRouteBinding, source: DurableInboundSource,
    signal: AbortSignal): Promise<PalDispatchOutcome>;
}
```

`DiskPalCommunicationStore({ root, secureDirectory? })` implements the durable
port using `DiskRevisionRecordStore`; no implicit global path. Its recipient
revision contains route reservations, pending/claimed entries and retained
receipt identities. Archived payload lookup uses authoritative immutable history,
not an unguarded writable index. In-memory store adapters must explicitly state
their lack of restart recovery.

`PalMessageBroker({ store, pals, authorize, host? })` validates current identity
and immutable intent, then accepts it. Host notification failure is observable
but cannot turn a committed receipt into "not accepted". `sender(context)`
produces the captured `PalMessageSender`; `send({ recipient, body, replyTo? })`
returns acceptance without waiting for the recipient's answer. This prevents
two Pals from holding their computers while synchronously waiting on each other.

`createPalMessagingTools(sender)` exposes `send_pal_message` and an explicitly
authorized `list_pals` view. Replies use an opaque accepted message reference.
Tool-result persistence must retain the stable acceptance ID. A replay of an
uncertain tool operation queries/reconciles this ID; it does not mint a new one.
The runtime tool-call identity or an existing resident outbox intent supplies
the idempotency key, not free-form model text or a new UUID on each retry.

Add optional `QueryParams.durableInbound` and the corresponding query-backed
agent pass-through. Preserve `inboundMessages` and its defaults. Extend
`RuntimeContextMessageSource` with optional, validated `deliveryRef`, using the
structural `InboundDeliveryRef` shape so message types do not import Pal code.
`createRuntimeContextMessage` can accept this metadata additively.

The iteration delivery path becomes async for the optional durable source:

1. Claim only the current authorized route at the existing provider-valid
   boundary. Reconcile unresolved claims before admitting another one.
2. Render the explicit source and body with the existing nonce-bound
   `formatSystemEvent`/untrusted envelope; use runtime-context `peer-message`.
3. Call normal `recorder.pushMessage(message)`, without `messageId` or transient
   options. This records the message instead of pretending it is already history.
4. Await `recorder.head()` (which synchronizes and flushes queued writes), resolve
   `recordedIdOf(message)`, then acknowledge the exact claim with its reference
   and covering pointer. No paid provider call follows before this completes.
5. If append or acknowledgement fails, surface the failure and retain the claim
   for reconciliation. Never silently discard the incoming message.

Make the `holdForOutstandingWork` delivery callback awaitable and combine the
optional source's abortable wake with existing input wake. Neither path injects
a message halfway through an assistant tool-call/tool-result sequence. Incoming
Pal context never replaces the latest operator request, clears its skills,
answers an approval, or implicitly creates a goal.

## Busy, idle, offline, and restarted hosts

- **Busy on this route:** attach its durable source to the existing query; notify
  its input wait. The kernel drains at the next valid boundary.
- **Busy on another route:** retain the message. Do not add another route's
  private context to the active query or acquire a concurrent computer controller.
- **Idle and authorized to wake:** an explicitly running host calls
  `dispatchPalMessagesOnce` for one selected route, validates/activates its claim,
  admits its pinned Pal/computer, and runs an ordinary query with this source.
- **Paused, unavailable, unauthorized, or offline:** retain pending acceptance;
  return a visible blocked/busy/offline outcome. No host-computer fallback.
- **Restart:** inspect durable pending/claimed entries, reconcile exact session
  evidence, and reattach or dispatch only under current host authorization.

`dispatchPalMessagesOnce` is a finite SDK helper, not another reasoning engine.
An embedding application explicitly owns any continuous listener and polling
policy. If an existing authorized resident pursuit should react, that host may
call `ResidentHost.notify`/`wake` for that real pursuit. Do not add a second
resident agenda or turn loop inside the broker. Cross-process notifications can
later use authenticated local IPC; correctness must survive a lost notification
because startup/explicit dispatch reads the durable inbox.

## Activity and action listeners

Use existing per-conversation `SessionEvent` replay and its sequence/generation
cursor. Validate immutable Pal membership before combining conversations into
an authorized activity view. The default view contains lifecycle facts and
references, not private message/tool bodies. A Pal runtime observer can report
computer generation/admission lifecycle, but an in-memory subscription must be
documented as live-only; it is not a durable event feed.

An authorized host policy can turn an observed event into a message intent with
an ID derived from policy ID, source session, generation and sequence. Replay
then deduplicates the intent. A listener itself grants no right to run a tool,
read a transcript, wake a Pal, or approve another actor's operation.

Approval callbacks require an opaque host token correlated to the exact actor,
connection, route, Pal, session, turn, checkpoint and current pending request.
Reuse [the existing AG-UI interrupt semantics](../../packages/ag-ui/src) and
session decisions. A stale, foreign, repeated, paused, or unsupported callback
is refused. Model text and form fields remain untrusted input. Do not claim a
Teams approval can resume a Pal checkpoint until that same-Pal resume flow has
an implementation and proof.

## Native external adapter boundary

Provide an additive host-side `PalChannelAdapter` contract with authenticated
normalized ingress and an optional explicit reply transport. Ingress resolves
connection, actor, route key and stable provider event ID, then uses the same
broker/store as local Pal messages. Its response acknowledges durable ingress,
not model completion. Its capabilities distinguish messages, replies, activity
notifications and actions; absent capabilities are refused.

Microsoft Teams transport requires provider app registration/authentication and
destination access or installation. A public authenticated endpoint or supported
connector may be needed even though the Pal computer remains local. This is not
available merely by creating a local Pal. See [Microsoft authentication](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/secure-your-agent)
and [proactive conversation requirements](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages).

Keep credentials in the host transport, outside guest computers, message
records, renderer state and model prompts. A local adapter test proves routing,
deduplication and actor policy, not a connected Teams deployment. Actual
credentials, webhook/installation and message exchange remain a separate
integration proof. The reviewed [direct Channels adapters](https://docs.copilotkit.ai/reference/channels/sdk/direct-adapters)
still require their public cloud runtime; import none of them for this slice.

External outbound delivery should reuse an actual existing resident outbox when
originating from that pursuit. Ordinary conversation replies need an explicit
stable provider operation ID and unknown-outcome handling before reliable
delivery can be claimed. Do not add a speculative second outbox or convert all
conversation replies into fake pursuits in the first local-message slice.

## Implementation slices and ownership

| Slice | Proposed files | Deliverable |
| --- | --- | --- |
| A: SDK route/inbox/broker | `packages/sdk/src/pals/communication/{types,store,broker,inbound,dispatch}.ts`, neighboring tests, `public-types.ts` and `public-runtime.ts` exports | Atomic reservation/acceptance, deduplication, exact claims, current grants, explicit host ports; actual disk-backed tests |
| B: query delivery | `types/message/index.ts`, `runtime/query/index.ts`, `runtime/query/iteration/{index,outstanding-work}.ts`, iteration context types, query-backed agent pass-through | Optional claim/append/flush/ack path with legacy behavior preserved and recovery failures tested |
| C: host composition | shared CLI Pal membership helper, `packages/cli/src/pals/communication.ts`, Pal session creation/tool wiring; desktop host uses the same composition | Captured sender tools, exact conversation claim, busy wake and explicit idle dispatch without host escape |
| D: local proof | SDK integration tests plus host command/fixture | Pal A sends to Pal B, B reads its own recorded untrusted context and replies; restart/duplicate/private-route proof |
| E: external boundary | SDK adapter contract and a native host fixture | Teams-shaped authenticated events use the same routes/inbox; no real account or cloud runtime claim |

Slices A and B may be independent implementation owners with a fixed
`DurableInboundSource` contract. C begins once that contract and explicit-revision
conversation claim are settled. Root owns public SDK/CLI documentation,
`docs/log.md`, changeset and coherent commit. No Team/coordinator schema is
needed for these slices.

## Required proof before "Pals can talk" is reported

1. Two disk-store instances race first reservation and duplicate acceptance:
   exactly one immutable binding/ordinal; matching retry gets the same receipt;
   conflicting payload and foreign tenant/route fail. Use deferred promises or
   direct filesystem concurrency, not a wall-clock timeout race.
2. Same native thread ID under different provider, connection or tenant maps to
   separate bindings. Windows path casing/delimiter inputs cannot alias them.
3. Crash after reservation, after root session claim, after message append and
   before acknowledgement: reopen, retain the same conversation/profile, reconcile
   the exact reference, and do not append the same message twice.
4. Append failure, acknowledgement failure, incomplete log and active foreign
   writer remain unresolved. A past matching record still deduplicates after
   compaction. Proven unstarted delivery is the only automatic pending recovery.
5. Busy turn receives input after tool results and before the next provider call.
   Provider sees runtime-context provenance and cannot treat it as operator
   steering. Deferred append proves no provider call/ack starts before flush.
6. Pause/grant revocation before dispatch and again before paid calls/tool work
   blocks execution. Busy on another conversation and stopped computer do not
   inject into a foreign/private route or run on the host.
7. SDK integration runs ordinary queries for two registered Pals with owned
   computer fixtures and the actual disk inbox: acceptance, recorded delivery,
   authorized nonblocking reply, and restart all work. Also run the available
   local engine host demonstration before claiming actual guest operation.
8. The CLI and desktop compose the same SDK port. An offline/missing engine
   produces visible queued/blocked status, never an invented completed response.
9. Teams-shaped fixture verifies authentication rejection, current actor grant,
   repeated event ID, actor change in the same thread, and separate private
   conversations. This is labeled a local adapter proof, not connected Teams.
10. Existing peers, resident outbox, ordinary query, delegated child and session
    lifecycle tests retain their behavior. New optional hooks leave defaults
    unchanged. Scoped typecheck/lint/tests and public-surface documentation are
    required before the slice is committed.

## Open integration decisions with concrete defaults

- First local-message implementation uses explicit host grants and manual/host
  dispatch; no automatically enabled recipient service. CLI/desktop can expose
  that listener deliberately after the shared SDK path has proof.
- Authorization is a required host policy port, not a permissive default. A
  missing policy refuses acceptance/wake. Stored evidence is audit-only.
- First external events support created text messages. Edits, deletion, bot
  actors, files, reactions, and approvals require explicit supported policies;
  they are not silently translated into new operator prompts.
- The first store retains deduplication receipts; archival preserves original
  immutable history. Physical garbage collection and transport read receipts
  are separate future contracts and are not needed for the first usable local
  Pal-to-Pal exchange.
