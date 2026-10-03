---
type: Reference
title: Persistent Pals and computer admission
description: Saved Pal identities, immutable profile revisions, injected local computers and exclusive execution admission in the SDK.
resource: packages/sdk/src/pals
tags: [sdk, pals, identity, computers]
status: draft
---

# Persistent Pals and computer admission

A Pal has a saved identity across conversations: its name, purpose, selected
provider/model and current pause state. A Pal conversation pins one immutable
profile revision. These records belong to `@namzu/sdk`; the CLI and desktop are
hosts of the same API. A Pal is separate from a delegated child agent and does
not require a desktop application.

## Store

`DiskPalStore({ root, workspaceRoot, secureDirectory? })` implements `PalStore`.
Both paths are explicit; the SDK does not choose a global application home.
They must be separate real directories without symlink aliases or overlap.
`workspaceRoot` holds empty, uniquely allocated **host control directories**.
These directories identify conversation storage and outputs; they are not a
virtual computer, an execution filesystem or a security boundary.

The store exposes `create(PalCreate)`, `get(id)`, `list()`,
`getRevision(id, revision)` and `update(id, expectedRevision, PalUpdate)`.
`DiskPalStore.atWorkspace(cwd)` additionally resolves an exact owned control
directory. Reserved control-root descendants and aliases are refused; they
cannot fall through to ordinary host execution.

A `PalDefinition` contains `v: 1`, `kind: 'pal'`, a UUID `id`, `name`, `purpose`,
`workspace`, `model`, `paused`, `revision`, `createdAt` and `updatedAt`.
`model` is `{ provider, model }` or `null` for host defaults. It contains no
provider credential. `PalCreate` accepts name, optional purpose and optional
model; `PalUpdate` accepts name, purpose, model and paused. Multiline purposes
are retained.

`PalDefinition`, `PalCreate` and `PalUpdate` also accept optional
`appearance: PalAppearance`. Its complete shape is `{ character, color }`: characters are
`pixel`, `sprout` or `spark`; colors are `green`, `blue`, `amber`, `violet` or
`rose`. Unknown values and extra fields are refused. Appearance is saved in the
same immutable profile revision as the other metadata. Omitted appearance stays
absent in existing records and unrelated edits; hosts choose their own display
default without rewriting the SDK record.

Each successful edit publishes an exclusive next revision. Existing revision
files remain unchanged. Two editors using the same expected revision cannot
both publish it: the loser receives `PalConflictError` and must reload.
Definitions and host control directories survive process restart. The optional
`secureDirectory(path)` hook lets hosts enforce user-specific Windows ACLs;
the default sets owner-only permissions on POSIX systems.

## A required virtual computer

`PalRuntime({ store, environments? })` admits execution only through an injected
`PalEnvironmentProvider`. An absent provider refuses execution. A plain host
folder is never an execution fallback.

`PalEnvironmentProvider.acquire({ pal, conversationId, signal? })` returns a
`PalEnvironmentLease` with the same `palId`, an opaque `environmentId`, a
positive integer `generation`, a guest `Sandbox`, a guest `ComputerUseHost`
and `release()`. Screenshot, mouse and keyboard capabilities are required.
A guest `BrowserHost` is optional. The provider may expose `probe()` returning
`{ ready, reason? }`. The embedding host is responsible for a truthful provider;
capability flags alone do not prove a virtual-machine boundary.

A lease may expose `operatorControl: PalComputerControl`. Its live `mode` is
`pal`, `operator` or `transitioning`; `takeOver()` and `returnControl()` transfer
exclusive authority, and `executeInput(PalComputerInput)` supplies human mouse,
scroll, text and key input to the same guest. The provider must reserve a
transition synchronously, confirm all guest operations and detached processes
are idle, and gate **every** agent shell, filesystem, browser and GUI operation
while authority belongs to the operator or is transitioning. A screenshot can
remain available as bounded readonly observation. A provider without this port
supports normal Pal execution but explicitly refuses manual takeover; the SDK
does not fall back to its generic GUI host for operator input.

The shipped [local computer provider](local-pal-computer.md) supplies a Linux
container desktop with persistent Pal storage through a preinstalled local
Docker engine. It does not mount the host control directory or inherit host
browser accounts. It shares the engine's kernel and is not a dedicated-kernel
VM. Provider credentials remain with the host's existing model routing.

## Live screen observation

A provider may expose `PalEnvironmentLease.screenStream: PalComputerScreenStream`
with `protocol: 'rfb'`, a `ws:` or `wss:` URL and an authorization header value.
`runtime.computerScreenStream(palId, generation)` synchronously captures a frozen
host-only descriptor for the exact current allocation. Missing, starting,
stopping, retired, closed or stale computers are refused; providers without
this optional capability explicitly report unsupported observation.

The descriptor is a transport credential, not a model tool result or a renderer
payload. The embedding host must keep it private, authenticate the connection,
and retire viewers with their allocation. It never acquires input authority,
wakes a Pal or satisfies an admitted agent's fresh-screen requirement. An
already warm paused Pal and an operator-controlled computer can still be viewed.
Providers must enforce read-only RFB observation at their server; a viewer's
`viewOnly` flag alone is insufficient. Existing screenshot and operator control
APIs retain their contracts.

## Ownership and lifecycle

`startComputer(palId, signal?)` starts or returns a warm computer.
`computer(palId)` returns its ready lease or null; `computerError(palId)` returns
an unavailable notice. `busy(palId)` reports an active controller, pending start
or pending stop, operator ownership, or an outstanding control operation.
`computerControl(palId)` reports `{ supported, mode }`, where `mode` also includes
`unavailable` when no usable control port exists. It exposes a runtime-reserved
transition before the provider begins the transfer.

`admit({ palId, revision?, conversationId, signal? })` returns `PalAdmission`:
its pinned `definition`, `lease`, `assertActive()` and `release()`.
One runtime allows one active controller for each Pal. Another conversation
receives an explicit busy refusal. The local provider also uses a deterministic
container name to refuse a second host process trying to own the same computer.
The SDK runtime's controller map is process-local; an embedding provider must
supply any required ownership across host processes.

The host must call `assertActive()` before every new guest file, shell, browser
or computer operation. It checks admission ownership, current pause state and
computer retirement. Pausing during computer startup cannot publish a usable
lease. A profile edit affects future conversations; a pinned revision remains
stable, while current pause state always applies.

`takeOver(palId, generation)` requires the exact current positive integer
generation and an idle Pal controller. The host must cancel and await existing
work before invoking it. The runtime reserves the operation before calling the
provider, preventing a concurrent admission or stop. The provider separately
refuses guest operations or detached processes that have not confirmed idle.
`executeOperatorInput(palId, generation, input)` requires current operator
authority and serializes input against another input, return or stop.
`returnControl(palId, generation)` transfers authority back without starting a
query, replaying input or automatically approving work. Stale generations and
foreign Pals are refused. A failed or unconfirmed transfer does not assume that
Pal authority was restored.

`PalComputerInput` accepts only exact mouse move/click/drag, scroll, text and key
shapes. Coordinates are integer physical pixels from 0 through 32767; the
provider also checks the actual guest display bounds. Scroll amount is an
integer from 1 through 100. Text has at most 100,000 characters and no NUL; keys
are nonblank, at most 100 characters, using letters, digits, underscore, plus,
space or hyphen. Inputs are captured before awaiting provider work. No shell,
file target, screenshot action or host selector is part of this input port.

Admissions and every `assertActive()` refuse operator or transitional authority.
After takeover, each later admission's `computerUseHost` refuses GUI mutations
until that admission successfully executes its own fresh screenshot. A raw
host preview or screenshot from an earlier admission does not satisfy this
requirement. Terminal/file work still uses the ordinary admission and provider
guards. A warm paused Pal can be controlled manually; returning its computer
does not unpause or wake it.

`PalAdmission.release()` releases the task slot and keeps the computer warm.
`stopComputer(palId)` refuses active work and releases the guest only after the
provider confirms cleanup. `close()` revokes admissions and stops all owned
computers, awaiting pending owned control operations before release. A failed release remains tracked and unavailable; stopping or closing
can be retried. A retired sandbox requires an explicit confirmed stop before
replacement. No failed cleanup is reported as a stopped computer.

## Durable communication

`PalAddress` contains a Namzu `tenantId` and stable `palId`. A `PalRouteBinding`
pins exactly one owned conversation and immutable profile revision. A different
Pal's transcript, browser, files and credentials are not shared by addressing it.

`DiskPalCommunicationStore({ root, secureDirectory?, maxPending? })` stores route
reservations and incoming intents in immutable recipient revisions. The optional
pending limit defaults to 256; admission refuses a full queue rather than
evicting accepted work. It is a queue resource bound, not a model token budget.
Roots are host-selected; Windows hosts should supply their current-user privacy
hook. Process restart recovery is supported on local filesystems with exclusive
hard-link publication. Power-loss durability is not claimed.

`PalMessageBroker({ pals, store, authorize, host })` requires a current policy and
a trusted `PalMessageHostPort`. `sender({ address, conversationId,
profileRevision })` captures the sender independently of model input. The host
must return actual owned session logs through `openConversation`; manufactured
membership evidence cannot activate a route. `send({ operationId, recipient,
body, replyTo?, dialogKey? })` returns durable **acceptance**, not delivery or
completion. The caller supplies a stable executor/outbox operation identity;
retrying an uncertain operation must reuse it with identical content and target.

Acceptance first reserves the immutable operation under its captured sender
conversation and operation ID, then atomically publishes the recipient route
and message. These are two recoverable commits, not a cross-record transaction.
If only the first stage commits, an identical retry completes it using the
original recipient/profile; changed content or another recipient is refused.
The acceptance receipt is returned only after the second commit completes.

An incoming delivery progresses from `pending` to one exact `claimed` writer,
then to `recorded` after normal message append, awaited flush and verified
acknowledgement. One recipient has at most one unresolved claim. Compaction
does not remove original delivery evidence. Unknown stop/append outcomes retain
their claim; clocks do not prove non-delivery and cannot authorize reinjection.

`createPalInboxSource` binds this storage to the optional
[query durable input port](query.md). Peer text remains untrusted runtime context,
with an exact delivery reference. It never becomes an operator request, tool
approval or permission grant. `dispatchPalMessagesOnce` is a finite explicit
host operation; the host owns ordinary query execution and computer admission.
Current receive and wake policy is checked separately. A dispatch host must also
recheck execution consent before each paid request and tool effect.
An unverifiable prior claim blocks delivery; the finite dispatcher reports
`idle` with reason `unresolved`. Recorded-input acknowledgement proves durable
transcript delivery, not that subsequent inference or task effects succeeded.

`DiskPalMessagePolicy({ root, secureDirectory? })` is an optional local operator
policy. Missing rules deny. `update({ source, recipient, expectedRevision,
enabled, allowWake })` grants or revokes one direction with compare-and-update;
zero creates a new rule. Reverse communication requires a separate rule. Wake
consent is explicit. `get` and `outgoing` return immutable current revisions;
`authorize` reads current consent on every call. A stored grant reference is
audit evidence, never continuing authority. Hosts can inject another policy
instead of this implementation.

`createPalMessagingTools` requires a captured sender/context, a current admission
callback and an explicitly authorized discovery callback. It exposes
`send_pal_message` and `list_pals`. The send operation identity comes from the
actual executor's session, batch and call IDs; a direct call without those IDs
refuses. The discovery view returns only declared Pal ID/name/description fields;
visibility does not itself grant sending authority. Replies must name an observed
incoming message and return to its authorized original conversation.

Communication does not start a resident daemon, create schedules, configure an
external transport or expose host plugins automatically. Pal Team coordination
and external channel membership are separate host concerns.
