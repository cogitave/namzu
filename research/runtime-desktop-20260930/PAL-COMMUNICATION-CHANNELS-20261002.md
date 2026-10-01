# Pal communication, activity, and external channels

Date: 2026-10-02. Status: source audit and proposed architecture, not a shipped
channel integration. This extends [the local environment audit](PAL-ENVIRONMENT-REFERENCE-20261001.md).
The local-only Pal computer constraint remains in effect. Pal Team coordination
and an organization chart are a later scope; Microsoft Teams is an external
messaging provider, not that organizational feature.

## Evidence and limits

Namzu baseline: `7235de9c4b2500d26abf826e383d5dd424630b87`, plus the in-progress
Pal SDK/CLI/desktop files in the schedule-ownership worktree. A local source
finding below does not assert that those changes have been committed, published,
or tested against a connected provider.

Sources inspected without running their applications or installing their SDKs:

| Source | Pin or observation | What it establishes |
| --- | --- | --- |
| [OpenDots source](https://github.com/CopilotKit/OpenDots/tree/8f53c3bb148068cf0405677de07df34cdfd2f680) | `8f53c3bb148068cf0405677de07df34cdfd2f680` | Template behavior and its stated limitations |
| [Channels reference repository](https://github.com/CopilotKit/channels-sdk/tree/986c20c2ccf5728066cc643fb0e1f43247b88b77) | `986c20c2ccf5728066cc643fb0e1f43247b88b77` | Examples and the pointer to the actual implementation |
| [Channels implementation](https://github.com/CopilotKit/CopilotKit/tree/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages) | `632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff` | Core, provider adapters, and managed delivery implementation |
| Official Channels documentation | Retrieved 2026-10-02; page footer `5ef6b35` | Current supported public contracts; not an inferred deployment guarantee |
| Microsoft documentation | Retrieved 2026-10-02 | Teams authentication and proactive-message requirements |

Read-only clones were used under `/var/tmp`; no dependency was added to Namzu.
No Slack/Teams account, app installation, public webhook, cloud runtime,
credential, or real message exchange was exercised. Upstream test source and
published demos are evidence about upstream intent, not our interoperability
test results. Current upstream source and some architecture prose differ;
implementation and current public reference take precedence in this audit.

## Decision

Keep one durable Pal identity and owned computer. Give each conversation its
own transcript, execution profile revision, and authorized route. Add an SDK
communication boundary used by CLI, desktop, schedules, and optional external
adapters. Reuse Namzu's existing session events, admission guards, and outbox
semantics. Do not import the reviewed SDKs or replace the agent kernel.

The proposed core terms are **Pal**, **conversation**, **message**, **channel
connection**, **route binding**, **inbox**, **outbox**, **activity event**, and
**approval**. A Pal Team's coordinator and membership are independent of these
transport primitives. A network A2A bridge can expose authorized Pal operations;
local communication does not need to travel through an HTTP protocol adapter.

## What OpenDots actually supplies

The template selects one configured specialist for Slack. Its identity policy
requires the configured workspace, an allowed human actor, and the configured
application owner. Created messages are eligible; edits and bot actors are
excluded. Mentions subscribe and invoke the agent; ordinary messages invoke it
only for subscribed threads. Pause is checked before execution and the Channel
requests serial handling. These are concrete application policies, not automatic
privileges supplied by a channel library.
[Slack implementation](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/slack-channel.ts).

The platform constructs that specialist using the same Dot identity available
in its UI. Before channel execution, a selector checks the application owner and
configured specialist, then binds a newly seen conversation to that Dot. SQLite
stores the conversation owner and Dot; lookup checks both. Sharing identity
therefore does not require merging every UI and Slack transcript.
[Platform](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/platform.ts),
[selector](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/learning.ts),
[workspace store](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/workspace.ts).

Its README explicitly calls multi-Dot group conversations and automatic
delegation future work. It also says connected Slack verification remains
outstanding, despite other locally demonstrated product features. Accordingly,
it supplies an identity/channel reference, not verified Pal-to-Pal coordination.
[Development status](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/README.md#development-status).

## Channels SDK: useful boundaries and limits

### Public lifecycle and locality

Direct adapters own the provider socket/webhook and credentials in the
application process. The supported public runtime still requires an Intelligence
connection; direct traffic bypasses its managed delivery layer and makes the
application responsible for transport reliability. There is no public standalone
Channel start method. Real Teams needs registered application credentials;
anonymous mode is for the local Agents Playground.
[Direct adapter reference](https://docs.copilotkit.ai/reference/channels/sdk/direct-adapters).
The source also rejects nonempty Channels configuration in SSE runtime mode.
[Runtime guard](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/runtime/src/v2/runtime/core/runtime.ts#L516).

That supported deployment model is unsuitable as a dependency for Namzu's
current local-only runtime. Its adapter boundary remains a useful reference:
normalization, provider rendering, capability discovery, and lifecycle belong
outside model reasoning. Public capability results can refuse an operation;
the caller must handle them. Provider name alone is not a capability contract.
[Platform boundary](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-core/src/platform-adapter.ts).

### Identity and conversation mapping

Identity context separates provider, tenant, installation, actor, conversation,
and event. Application identity is resolved for every event. An actor ID, display
name, installer, or conversation starter must not implicitly become the identity
or personal-memory subject of all other participants. Personal and project
memory access are explicit per-run grants.
[Identity and memory](https://docs.copilotkit.ai/slack/identity-and-memory).

Direct Slack derives a native key from channel ID and thread scope; direct Teams
uses its native conversation ID. Managed delivery uses a canonical thread ID
supplied by the gateway. These are different authority and persistence paths.
Namzu should store a structured, namespaced key rather than assume any native
ID is global.
[Slack key](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-slack/src/interaction.ts#L15),
[Teams key](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-teams/src/interaction.ts#L35),
[managed dispatch](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-intelligence/src/delivery-adapter.ts#L388).

The state-backed conversation helper persists native-key-to-agent-thread mapping
using a read followed by a write. That helper alone is not exclusive first-claim
admission across processes. The direct Teams adapter's default history is a
process map and it creates a fresh agent thread per turn. Avoid mistaking that
default for durable history.
[Mapping helper](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-core/src/state/state-conversation-store.ts),
[Teams store](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-teams/src/conversation-store.ts).

### Delivery, state, and ordering

The SDK store contract includes atomic consume, token-owned locks, deduplication,
and FIFO operations. Its default implementation is process memory. The queue
contract has destructive dequeue, without a claim/ack/recovery lifecycle.
[Store contract](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-core/src/state/state-store.ts),
[memory implementation](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-core/src/state/memory-store.ts).

Direct serial dispatch uses an in-process promise chain. Ingress deduplication
records an event before invoking handlers and proceeds without deduplication on
store failure. This does not establish durable replay of failed direct handlers.
It is separate from the gateway's delivery ownership, not a substitute for it.
[Dispatch implementation](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-core/src/create-channel.ts#L725).

Managed delivery claims a prepared delivery and sends ordered provider-effect
packets with exact acknowledgments. Known retry waits replay the same packet;
uncertain provider results terminate rather than blindly repeat effects. Managed
admission also restricts one canonical thread at a time. SDK state still needs
its own durable backing and application writes need idempotency.
[Persistence reference](https://docs.copilotkit.ai/slack/persistence-and-scaling),
[delivery implementation](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-intelligence/src/delivery-transport.ts).

### Interactive actions

Current continuation snapshots bind a random action capability to channel,
conversation, thread, run chain, and initiator. Claim validates the binding and
atomically consumes the action. This prevents a second resumed run using the same
continuation; application policy still decides whether the clicking actor may
authorize the underlying operation. Named, registered components and durable
snapshots allow callback reconstruction after restart.
[Continuation registry](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-core/src/action-registry.ts#L494),
[snapshot shape](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-core/src/action-store.ts).

Managed approval flow posts an action and ends its delivery; a later authenticated
interaction resumes it. In-process awaiting is unsuitable for that managed
delivery contract. Subscription flags also do not establish a complete proactive
routing system.
[Thread reference](https://docs.copilotkit.ai/reference/channels/classes/Thread).
Teams submits opaque action IDs and form values; the submitted values remain
user input, not trusted resume state.
[Teams interaction decoder](https://github.com/CopilotKit/CopilotKit/blob/632b050da4a3ee5a8eb3e263316b9acd2fdfe6ff/packages/channels-teams/src/interaction.ts).

## Namzu: reuse and verified gaps

| Existing primitive | Verified behavior | Pal/channel gap |
| --- | --- | --- |
| [SDK peers](../../packages/sdk/src/peers/record.ts), [CLI mailbox](../../packages/cli/src/integrations/peers/runtime.ts) | Authenticated local live-session identity; same-project/mode policy; bounded process mailbox; accepted is not model-delivered | Address is a live session, not a durable Pal; pending mail disappears with its process |
| [Agent manager](../../packages/sdk/src/manager/agent/lifecycle.ts) | Owned child tasks, tenant checks, pending capacity, follow-up queue | A child task is not an independent reusable Pal or external actor |
| [Query ingress](../../packages/sdk/src/runtime/query/iteration/index.ts), [wake contract](../../packages/sdk/src/runtime/query/index.ts) | Queued messages drain at a provider-valid request boundary; wake signal is distinct from consuming input | Host must durably admit input, route it to the correct conversation, and wake an idle Pal |
| [Pal runtime](../../packages/sdk/src/pals/runtime.ts) | Pinned definition revision, current pause checks, one active computer controller per runtime, environment generation | No Pal message router/inbox, external bindings, or Pal computer lifecycle observer; cross-process authority still depends on host/provider admission |
| [Session events](../../packages/sdk/src/types/session/events.ts) | Tool/action/activity/turn events; durable events carry sequence and generation, with per-session reconnect cursor | Pal-wide aggregation must resolve authoritative conversation ownership; ephemeral events have no replay guarantee |
| [External references](../../packages/sdk/src/types/session/turn.ts), [session index](../../packages/sdk/src/store/session-index/index.ts) | Arbitrary protocol names and caller IDs; index rebuilt from log claims; earliest claim wins | An index lookup is not exclusive route admission, actor authentication, or permission to merge histories |
| [Resident outbox](../../packages/sdk/src/manager/resident/outbox.ts), [agenda](../../packages/sdk/src/manager/resident/agenda.ts) | Durable immutable intent; exact claim settlement; transport receipt; uncertain sending is not automatically retried | Existing messages belong to a resident pursuit; no generic Pal conversation inbox or provider mapping |
| [Resident host](../../packages/sdk/src/manager/resident/host.ts) | Local wake/control loop and durable agenda rereads | Must bind an admitted Pal conversation/profile/computer; a listener does not authorize a new goal |
| [AG-UI interrupts](../../packages/ag-ui/src/interrupts.ts), [adapter](../../packages/ag-ui/src/adapter.ts) | Session/turn/checkpoint/group correlation; atomic settle contract; host authorizes scope; stale/duplicate resumes rejected | No Teams authentication or Pal route/actor grant supplied by this protocol mapper |

The current Pal CLI composition already forwards inbound/wake callbacks and
session events to the SDK query. Thus the missing work is durable admission and
ownership-aware routing, not a second agent loop. Its Pal TUI deliberately does
not expose ordinary host terminal-peer or host plugin access.
[Pal query composition](../../packages/cli/src/pals/agent-session.ts),
[Pal TUI](../../packages/cli/src/tui/App.tsx).

## Proposed contract and state machine

The following is a Namzu design inference from the sources and local contracts.
It is not claimed as an implemented upstream or Namzu API.

### 1. Stable address and route

- Address a Pal with an application tenant/owner namespace and stable `palId`.
  Display names and live session IDs are metadata, not durable addresses.
- Bind each route to that address and one conversation with its pinned profile
  revision. External route identity includes provider, provider tenant/workspace,
  installation/application, native conversation, and native thread scope where
  available. Encode tuples unambiguously; do not concatenate unchecked IDs.
- Internal Pal messages carry authenticated sender Pal and conversation, recipient
  Pal, message ID, correlation ID, optional reply-to, and a separately admitted
  recipient conversation. External sender identity is resolved per event.
- A route policy determines allowed actors, triggers, memory scopes, send rights,
  approval rights, and automatic wake. Grants are persisted separately from the
  transcript; the host validates current grant state again before execution.
- Shared Pal memory requires explicit access scopes. A group-channel participant
  must not receive a Pal's private direct-conversation history or browser accounts.

### 2. Durable inbox and recovery

Persist authenticated ingress and its route decision before acknowledging
acceptance or waking the agent. Use a stable delivery key scoped by provider,
tenant, installation, and event ID; internal messages use stable sender and
message ID. Duplicate content conflicts under the same key are rejected.

Use explicit states: `pending`, `claimed`, `injected`, `settled`, `refused`, and
`unresolved`. A receipt can prove persistence, injection, or turn settlement;
none proves that a human read it or an external business effect succeeded.
Claimed records bind the exact conversation, profile revision, grant revision,
computer admission/generation, and turn. Do not destructively dequeue before
durable injection. Crash recovery reconciles the claimed message with its session
record before starting another model turn. Uncertain tool/provider effects remain
unresolved until reconciled; a timeout alone is not evidence of non-acceptance.

Reuse the outbox's immutable IDs, exact claim, and acknowledgment distinction.
Keep inbox and notification/outbound-effect journals separate. The current
pursuit-specific outbox should not become a generic messaging database by
inventing a pursuit for every chat message.

### 3. Busy, idle, paused, and offline behavior

| Pal state | Ingress behavior |
| --- | --- |
| Active in the same conversation | Persist then inject permitted contextual input at the next safe provider boundary; preserve ordering and correlation |
| Active in another conversation | Queue for that conversation; do not run concurrent input on the same computer or move another transcript's input |
| Idle and authorized to wake | Admit a new turn using the saved route/profile and actual computer; use the same SDK path as CLI/desktop |
| Paused | Persist permitted inbox items without executing; show pending/refused policy outcome |
| Offline or computer unavailable | Retain pending work and explicit availability state; never fall back to host execution |

An internal Pal message is untrusted peer context, not an operator instruction
or approval. Route policy can restrict it to a later turn instead of steering
current work. Listening, replying, and starting autonomous work are separate
grants. Ordered same-conversation ingress and exclusive per-Pal computer control
are both necessary. Queue capacity and admission refusal protect resources; they
are not model token-spending limits.

### 4. Activity listeners and outbound notifications

Use existing `SessionEvent` for reasoning-independent facts: tool started,
completed, review requested, activity changed, and turn settled. Project those
events through verified Pal conversation ownership. Add a small Pal-runtime
observer only for computer/admission lifecycle facts not present in a session.

A listener observes; it does not grant authority or directly execute model text.
Host event-trigger policy can create a durable, idempotent work intent. Replayed
events must not create repeated work. Live subscription is an optimization over
durable reconciliation. For replay, keep one `(sessionId, generation, seq)` cursor
per session; do not use a single Pal-wide integer or promise recovery of token
deltas. An aggregate feed may persist its own cursor-to-session mapping later.

Select a permitted notification route explicitly. Filter payloads before leaving
the application; no raw credentials, browser state, private transcripts, or tool
results in a default activity notice. Transport acceptance and user reading are
different receipts. Never automatically echo external events back through the
same adapter and create a message loop.

### 5. Actions and stale approvals

Keep an action distinct from chat text and a completed activity. Mint an opaque,
single-use server record bound to tenant, Pal, conversation, turn, checkpoint,
tool call/batch, reviewed arguments, profile revision, environment generation,
grant revision, permitted actor, and expiry. A provider callback supplies only
the action token and validated user/form input. It cannot supply a new trusted
session, tool name, permission scope, or computer identity.

Authenticate the provider delivery, resolve the current actor, compare all
bindings, enforce current grants/pause/takeover state, then atomically claim the
action before handing it to the native HITL continuation. Reject duplicates,
expired decisions, another conversation's card, changed arguments, retired
computer generations, and denied tool authorization. Approval recovery should
reuse native checkpoint semantics; the current Pal MVP explicitly refuses
parked-turn resume, so external approval resume needs a later validated slice.

### 6. Microsoft Teams adapter

Implement the optional provider adapter outside the core SDK. Keep platform
credentials and inbound verification in the host; pass normalized authorized
ingress into the SDK communication service. Provider rendering and capability
differences stay in the adapter. Store the authenticated conversation reference
for later notifications; allow only policy-admitted destinations and service URLs.

The Pal can execute on a local device, while real Teams messaging still uses
Microsoft's service and registered app. Production ingress requires valid
authentication; anonymous Playground traffic is only a development fixture.
[Microsoft authentication](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/secure-your-agent).
Proactive delivery requires the app's access/installation in the destination and
saved addressing information; a Teams user ID is scoped to its bot. Local hosting
does not remove these provider requirements.
[Microsoft proactive messages](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages).

Do not expose a local unauthenticated endpoint or create provider accounts,
install apps, or provision public infrastructure as part of source-only research.
A real provider smoke test is a separate authorized integration step. First
prove the SDK using an in-memory fake adapter and durable local fixtures.

## Implementation order after the current Pal core change

1. **Small additive SDK gap:** add an optional typed Pal-runtime observer for
   computer start/ready/failure/stop and admission/release. Carry Pal ID,
   environment generation, and conversation where applicable; exclude provider
   credentials and transcripts. Observer exceptions must not acquire authority,
   prevent cleanup, or corrupt admission. This is live lifecycle evidence, not a
   newly promised durable event feed. Test successful and failed startup,
   contention, release, close, throwing observers, and unsubscribe behavior using
   explicit promises/fake timers where needed.
2. **Next SDK-owned slice:** stable Pal-addressed durable inbox and route-binding
   admission, composed with existing conversation logs and computer admission.
   This is larger than a schema-only patch. Its minimum proof includes duplicate
   ingress before/after restart, conflicting IDs, cross-Pal/cross-tenant refusal,
   atomic first route claim, two processes claiming one message, pause and
   generation changes, crash between claim and injection, and honest unresolved
   effect handling. No real provider adapter is needed for that proof.
3. Bind CLI/desktop to that same service. Add directed Pal-to-Pal messaging through
   explicit grants, then authorized idle wake and activity notification routes.
4. Add the external adapter and its authenticated contract tests. Add durable
   approval continuation only after native Pal parked-turn recovery works.
5. Add Pal Team membership/coordinator and mission dependency scheduling on top of
   those primitives. Team membership alone must not grant message, computer, or
   approval authority.

The first observer can be implemented independently after the current coherent
core commit. The inbox and route slice should be reviewed as an admission and
recovery feature, not represented as completed by a transport callback or a UI
listener. No channel feature was implemented during this audit.
