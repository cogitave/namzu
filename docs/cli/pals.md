---
type: Reference
title: Pals in the CLI
description: Create, customize and chat with persistent Pals using the same SDK identity and local computer as the desktop.
resource: packages/cli/src/pals
tags: [cli, pals, computers, sessions]
status: draft
---

# Pals in the CLI

`namzu pal` operates the SDK's saved Pal records. The desktop reads these same
records and uses the same CLI host for conversation execution. Pals retain their
name and purpose across conversations and can each have their own local guest
computer. They are distinct from a normal project chat or delegated subagent.

## Commands

```sh
namzu pal list --json
namzu pal create Research --purpose "Separate AI news by model" --model zen/space-bunny-free
namzu pal show <pal-id> --json
namzu pal update <pal-id> --revision 1 --name Researcher --purpose-file purpose.txt
namzu pal pause <pal-id>
namzu pal resume <pal-id>
namzu pal chat <pal-id>
namzu pal chat <pal-id> --resume <conversation-id>
```

`create` accepts a name, `--purpose` or `--purpose-file`, and an optional
`--model provider/model`. `update` additionally accepts `--name` and
`--revision`; `--model default` clears the saved model. `pause` and `resume`
change the current pause state, optionally using `--revision`. Metadata commands
accept `--json`. An omitted expected revision uses the version read when the
command begins; a competing update is still refused rather than overwritten.

`create` and `update` accept `--appearance <character>/<color>`, for example
`--appearance spark/violet`. Characters are `pixel`, `sprout` and `spark`; colors
are `green`, `blue`, `amber`, `violet` and `rose`. Both choices are saved together
in the shared SDK profile. The desktop uses `pixel/green` when appearance is
absent; reading an older Pal does not add that default to its stored revision.

`pal chat` opens the regular terminal interface with Pal-specific composition.
Its exit hint preserves the executable that launched it and reopens the same
Pal conversation. Missing local-computer setup produces an explicit refusal.

## Computer setup and execution

Install a local Docker engine running Linux containers and explicitly build
[the Pal computer image](../sdk/local-pal-computer.md). Namzu never silently
installs Docker, builds or pulls that image. The CLI supports
`NAMZU_PAL_COMPUTER_IMAGE` and `NAMZU_PAL_DOCKER_BINARY` to select the image and
engine executable. Docker's selected endpoint must be a supported local Unix
socket or Windows named pipe; remote engines are refused.

Foreground application launchers default to `computer-lifetime`: a successful
launcher may return while Blender or another application remains owned by the
Pal's exclusive computer. Rebuild the shipped image from the same Namzu release
to use this policy; an older worker is refused before a foreground command is
admitted. Registered background jobs keep strict process ownership. Set
`NAMZU_PAL_COMPUTER_NORMAL_EXIT_POLICY=strict` before launching the CLI or desktop
host to retain the previous foreground command lifetime and use an older strict
image. The only accepted values are `strict` and `computer-lifetime`; malformed
values are refused before provider startup. Applications retained by the computer
stay open during operator takeover and end when the computer stops.

The Pal's file, shell and computer tools execute in its Linux guest. Visible
Chromium is operated through `computer_use`; the operator's host browser is not
an implicit fallback. Host provider credentials route model requests and are not
copied into the guest. Browser-site accounts are not inherited automatically.
The local provider supports guest background commands through its detached-process
API, with output piped back to the owning conversation. Stopping a job requires
confirmed guest termination; failed cancellation retains a recovery notice and
can be retried. It does not implement a PTY, guest TCP tunnel or semantic browser
API; requests needing those capabilities report that limitation.

Host plugins, MCP servers, project instruction files, skills, subagent launchers
and scheduler commands are not implicitly loaded into a Pal conversation.
A Pal's saved purpose reaches the actual model system context. The saved model
is selected before provider construction, and provider settings report the
conversation's actual selection. A model change in a conversation is local to
that conversation; customizing the saved Pal affects newly created conversations.

Pal sessions use the SDK's shared conversational system instructions: the saved
name and visual character identify the Pal, while the selected model powers it.
They start in English until the user uses or requests another language. Normal
chat favors short, friendly replies; raw tool logs and internal reasoning are
not public answers. Substantive outputs require actual confirming tool evidence.
An authenticated rename or appearance edit updates the next turn's display
identity; the conversation's purpose, model, workspace and permissions remain
pinned to their original revision.

ACP and admitted manual chat turns use exclusive SDK conversation admission independently of computer
readiness. An offline or operator-controlled computer supplies zero tool
definitions: no guest or host files, shell, browser, GUI, messaging or plugins.
The desktop's explicit Start computer or Return control enables the actual guest toolset
on the next turn without recreating the chat session. These turn admissions do
not start a computer. The standalone `pal chat` command retains its existing
computer-startup preflight before launching the terminal interface; unavailable
setup still refuses that command's startup. Directed dispatch and checkpoint resume retain their mandatory
guest admission and refuse unavailable or operator-held computers.

Owned Pal conversation claims and listings also return `palGreeting` with a
stable display ID and English introduction from their original immutable
profile revision. This onboarding prelude is separate from recorded model
messages and does not start a paid turn or a computer. Renaming a saved Pal does
not rewrite an existing conversation's original introduction.
The first real turn receives that host introduction as system context, not as
a fictional earlier model turn. Pal desktop history projects delivered public
assistant text and excludes explicit commentary and assistant tool-call rows;
the original messages remain intact in the durable journal for replay.

A Pal's computer stays warm between turns and conversations in the same host
process. One conversation controls it at a time. Closing the host releases the
container and retains the Pal data volume. Unknown execution cancellation can
retire a computer; its current operation is refused until a confirmed stop and
restart. A failed stop keeps ownership tracked for retry.

## Working with applications and reference images

Ready Pal conversations use the SDK's
[shared application work guidance](../sdk/pal-work.md). It asks the Pal to
understand the requested outcome and supplied references, inspect the current
document, choose a reliable supported API or GUI, and make reversible changes.
After meaningful work it should observe the actual result, compare it with the
task and correct mismatches. Delivery should verify the saved native file and
requested exports, with task-relevant visual, content, data or functional
checks. These habits apply across applications; ordinary chat does not become
a form or a checklist.

This is model guidance, not guaranteed quality or a grant of authority. A
successful command or a file-presence check cannot establish that a drawing,
document, calculation or exported model is correct. The Pal must distinguish
what it created, what it actually inspected or tested, and what remains
uncertain. A conversation checkpoint does not prove that an application saved
its document. SDK embedding hosts can set `workGuidance: 'basic'` to omit the
new application guidance; that is an SDK prompt option, not a CLI permission
preset or a saved Pal field.

An image attached to the current message can be visible to the model before
it is available to an application. `import_reference_images` takes `{}` and
copies validated original inline images into the admitted guest, returning a
manifest that maps one-based attachment positions to verified guest paths.
The model cannot choose a host file, filename, URL or base64 payload for this
operation. It does not download images or resolve stored attachment references.

Import is an explicit `file_write` tool call under the normal permission and
review policy. Attaching an image alone writes nothing. Ask first can require
approval, preapproved-only mode requires an applicable allowance, and current
plan mode refuses the write even when an earlier durable approval is replayed.
Pause, takeover, generation and changing execution authority remain checked
before guest operations. A stopped or operator-held computer supplies no import
tool and introduces no host fallback; the Pal can still discuss the image
through its normal model input when the selected provider supports it.

Imports use the shipped Linux guest's Python 3 filesystem operations. They
accept at most eight inline PNG, JPEG, WebP or GIF images, each at most 3 MiB
and together at most 12 MiB. Files live under the guest workspace's
`.namzu/references/<sha256>.<extension>` and survive its persistent volume's
restart. Matching bytes are reused, and existing conflicting files are not
overwritten. A confirmed path establishes file availability; observing an
application load it and comparing the output with it are separate steps.

The session keeps current input apart from cached history. Sending a new turn
does not silently import earlier images. A durable reviewed import recovers
the original attachment bytes from that exact turn's journal and retains its
recorded manifests. Original user attachments and conversation history are not
rewritten to insert guest paths. An interrupted import can leave private guest
scratch without publishing a successful manifest; lost authority does not
authorize another operation for cleanup.

`view_image` reads a saved PNG, JPEG or WebP artifact through the current guest
and sends actual image content to a capable model. It is a read-only
`file_read` operation, available in the admitted Pal toolset. The host disables
it before reading when the provider cannot receive image tool results. It
accepts static images up to 16 MiB, 16,384 pixels per edge and 16 million pixels
total. PNG pixels are decoded and fitted; JPEG/WebP containers are validated
without decoding or resizing compressed pixels, and must already fit the
standard vision size. Unsupported or excessive files need a supported export.

Artifact inspection is separate from the live computer viewer. Reading an
image does not establish current mouse coordinates or prove what is on screen.
The Pal must acquire a fresh `computer_use` screenshot before GUI input and
after control returns from the operator. The operator's live preview is not an
observation delivered to the model. Full tool limits and SDK contracts are in
[Pal application work and visual evidence](../sdk/pal-work.md).

## Storage and conversation ownership

Saved definitions are immutable numbered revisions under
`NAMZU_HOME/pals/<pal-id>/revisions/`. Separate host control directories are
allocated under `<parent of NAMZU_HOME>/<NAMZU_HOME basename>-workspaces/pals/`.
These directories are never mounted into the guest. Their exact path identifies
a separate conversation project, including when the application home happens to
be inside an unrelated Git checkout. Reserved control-root descendants and
symlink aliases are refused before ordinary host or provider initialization.
An exact Pal directory requires an explicit Pal environment; an ordinary
headless command cannot use its inherited folder trust to initialize host tools.

A conversation's first log record claims exactly one Pal and one profile
revision. An ordinary existing session cannot be adopted by a later claim.
History, sends and Pal job access reject unclaimed or foreign conversations.
Listings validate membership before their output limit and retain an empty
claimed conversation across restart. A repeated valid claim retains its original
revision rather than switching it to the Pal's newest profile.

Current pause state blocks the next admission and each next guest operation.
It does not rewrite a conversation's pinned purpose or model. Pausing is not a
request to terminate an already admitted process halfway through an operation.

This MVP has no autonomous resident loop or Pal Team. Manual compaction is not
available in Pal sessions. A new user message can continue a settled or
explicitly abandoned turn.

## Parked turns and authenticated review actions

The Pal session host supports `AgentSession.send(messages, { reviewHold: { reason } })` through its
ordinary send options. Under `prompt`, a tool batch requiring a person is saved
as a real checkpoint and `decision_requested` record, and the turn pauses
without executing that batch. An explicit hold ignores a live prompt callback
and has no remembered approval. Without a hold, the existing terminal and
desktop permission prompts continue to operate normally. A gate deny still
refuses the call; holding a review does not override the gate.

`AgentSession.resumePaused` and `resumeDurable` resume through the SDK's
`resumeSession` using the Pal's original conversation journal, same turn and
checkpoint, pinned model and purpose, and actual local computer admission.
They restore the original recorded token, iteration and timeout limits. They
refuse foreign journals, a changed model, incompatible answers, expired or
replaced reviews, and completed turns before acquiring the guest. The host
holds the original session writer while rechecking the park, renews its fence
before tools and model requests, and retains failed cleanup for an explicit
close retry. A supplied writer lease remains owned by its caller and is checked
before each resumed tool or model request. No host filesystem or computer
fallback is introduced.

The trusted CLI host factory `createCliPalReviewActions` supports a separate
authenticated action path for **tool reviews**. It captures the pinned Pal,
owned scope, original journal, bound native resume port and live authorization
callback. A verified
channel adapter must supply its authenticated actor and stable upstream
operation identity. Its action names the exact session, turn, checkpoint,
decision, original `decision_requested` record pointer and committed checkpoint
document hash. Only `approve_once` and `reject` with feedback are accepted;
there is no channel grant for later batches, arbitrary modified tools or sandbox
escape. A later review is held again. Observation access alone does not grant
decision authority.

Hosts must supply `currentPermissionMode` as a captured live policy callback.
An absent or invalid port refuses the action; it never assumes prompt mode over
an existing plan policy.
Current plan mode refuses changes in a restored approved batch and sends later
rule-allowed batches through the same CLI plan review controls. This callback is
trusted host state; action payloads cannot change the permission mode.

Within this authenticated action only, current `auto` and `accept-edits` modes
are limited to `prompt` for later review requests, including a mode changed
while the approved batch runs. Current `plan` and `strict` remain stricter.
Independent explicit operator rules can still authorize their own calls; this
action supplies no later grant or approval latch. Normal operator sends and
resumes retain their existing automatic-mode behavior.

Reservations are fsynced under `NAMZU_HOME/pal-review-actions/` before execution
and bind both the upstream operation and the exact decision. A matching retry
returns the original journal's actual `decision_resolved` pointer; changing the
actor, answer or request conflicts. Concurrent attempts cannot execute the same
reserved decision. A failed or interrupted attempt without an authoritative
resolution retains its reservation and reports that reconciliation is required;
it is never guessed safe to execute again. The receipt confirms application of
the decision, **not success of the tools**. Current pause and actor consent are
rechecked before resumed tools and inference. A revoked tool can remain
unexecuted even if the kernel recorded the applied approval. Kernel resolution
records retain their system policy attribution; the host reservation separately
records the authenticated actor without claiming it is a kernel human record.

These are trusted host APIs. A raw renderer or model payload is not a runtime
decision. Channel integration must verify its original delivery and native
conversation and actor binding before invoking this gate. Durable plan approval
is not exposed by this action path.

## ACP host extensions

Run `namzu acp --desktop` to expose the Pal host extensions over the desktop
ACP connection. Metadata methods use the application home. Execution methods
must use the Pal's own validated control-directory client, whose runtime owns
that computer. `namzu/project/status` includes optional `pal` metadata when the
exact current directory belongs to a Pal.

| Method | Parameters | Result |
| --- | --- | --- |
| `namzu/pals/list` | none | Saved Pal definitions |
| `namzu/pals/get` | `{ id }` | Definition or null |
| `namzu/pals/create` | `{ name, purpose?, model?, appearance? }` | New definition |
| `namzu/pals/update` | `{ id, expectedRevision, name?, purpose?, model?, appearance?, paused? }` | Next immutable definition |
| `namzu/pals/conversations/claim` | `{ palId, sessionId }` | `{ sessionId, palId, revision, palGreeting }` |
| `namzu/pals/conversations/list` | `{ palId }` | Owned recent conversation rows, including empty ones |
| `namzu/pals/computer/status` | `{ palId }` | Computer availability |
| `namzu/pals/computer/start` | `{ palId }` | Ready computer identity |
| `namzu/pals/computer/stop` | `{ palId }` | Confirmed stopped state |
| `namzu/pals/computer/stream` | `{ palId, generation }` | Host-only RFB descriptor, exact geometry and generation |
| `namzu/pals/computer/screen` | `{ palId, generation? }` | PNG data URL `source`, `width`, `height` |
| `namzu/pals/computer/take_over` | `{ palId, generation }` | Ready computer identity and operator control |
| `namzu/pals/computer/return_control` | `{ palId, generation }` | Ready computer identity and Pal control |
| `namzu/pals/computer/input` | `{ palId, generation, input }` | `{ type: 'ok' }` after confirmed guest input |

Definitions have the [SDK PalDefinition shape](../sdk/pals.md). The computer
status has `status: 'ready' | 'stopped' | 'unavailable'`; ready includes
`environmentId` and string `generation`. Unavailable may include `notice` and
`requiresStop: true` when owned-resource cleanup must be retried. A screen is an
actual capture from the guest, never the operator desktop. Conversation rows
contain `id`, `title`, `named`, `updatedAt`, message `count` and `hasPrompted`.
Claim immediately after `session/new` and before history, settings or prompt
access. Ordinary session IDs and a different Pal's IDs confer no access.

Ready computer state additionally includes
`control: { supported, mode: 'pal' | 'operator' | 'transitioning' | 'unavailable' }`.
An unsupported third-party provider is reported truthfully and cannot receive
manual input through a generic computer fallback. Control requests must use the
same trusted Pal workspace client that owns the actual guest, with its exact
current generation encoded as a canonical positive decimal string. Leading
zeros, signs, exponent notation, nonintegers and stale generations are refused.
Screen requests optionally pin this generation; all captures recheck the
computer identity and generation afterward, so a replaced guest's old image is
not returned.

`namzu/pals/computer/stream` is an owning native-host extension. It requires
that same trusted Pal workspace connection and exact canonical generation,
then rechecks the lease after reading its geometry. Its response contains
`protocol`, `url`, `authorization`, `width`, `height` and string `generation`.
The allocation authorization must never cross into renderer IPC, logs or model
results. A native host supplies its own read-only viewer ticket instead. The
method refuses unsupported providers; it does not synthesize a stream from
periodic screenshots or grant input authority.

The CLI reuses initialized registry stores only while the configured home and
canonical root identities remain unchanged. This avoids repeated Windows ACL
subprocesses during input. Pal definitions, revisions, pause state and workspace
admission remain fresh reads; a changed/replaced root rebuilds initialization.

The desktop host cancels and drains existing Pal work before takeover. The SDK
then fences new admissions and the local provider independently requires idle
guest foreground operations and detached processes. While operator control is
active, every agent filesystem, shell, browser and GUI effect is blocked; bounded
readonly screen previews remain available. Human input is limited to the
[SDK PalComputerInput shapes and bounds](../sdk/pals.md#ownership-and-lifecycle),
with actual guest geometry checked by the provider. Input, control return and
stop cannot overlap an outstanding control operation.

Returning control starts no query and restores no approval. On its next explicit
turn, the Pal must obtain its own fresh screenshot before GUI input; the desktop
preview cannot satisfy this observation. A warm paused Pal computer can still be
controlled manually, and returning it leaves the Pal paused. These controls apply
to the same local container guest; they do not expose the operator desktop or
claim a dedicated-kernel VM boundary.

A Pal connection's plugin listing is empty with a clear notice. Host plugin
mutation is refused because Pal composition has no host plugin manager. Saved
profile updates through the active Pal client refuse its active controller;
the desktop additionally checks queued work and jobs before customization.

ACP shutdown attempts both conversation cleanup and Pal-computer cleanup even
when either fails, including a regular ACP connection that opened an existing
Pal conversation. Cleanup errors are preserved together. A Pal conversation
whose job cleanup failed remains closable for an explicit retry.

For the local engine/image requirements, including the supported Windows Podman route, see [Local Pal computer](../sdk/local-pal-computer.md). Engine selection does not change the Pal identity or guest-only tool boundary.

## Directed messaging consent

The terminal and desktop Pal sessions mount the same SDK `list_pals` and
`send_pal_message` tools. Discovery shows only explicitly granted recipients,
with ID and name; it does not expose their purpose, history or credentials.
Sending also passes the current broker policy and the ordinary tool permission
gate. No Pal has an implicit communication grant.

```sh
namzu pal grant <sender-id> <recipient-id>
namzu pal grant <sender-id> <recipient-id> --wake
namzu pal revoke <sender-id> <recipient-id>
namzu pal inbox <recipient-id> --json
namzu pal dispatch <recipient-id> --json
```

`grant` authorizes explicit sender disclosure and recipient receipt in one
direction. Reverse replies need a separate reverse grant. `--wake` separately
permits an explicit dispatcher to start a peer turn. `grant` and `revoke` accept
`--revision <n>`; zero means a new rule. Omitting it reads the current revision
and still refuses a concurrent stale update. These commands affect only the
current Namzu home's local tenant and persisted Pal IDs.

`inbox` reports every accepted input family in the shared ledger: message ID,
delivery status and owned conversation ID. Existing peer rows retain `sourcePalId`.
Observation rows add `sourceKind: host-observation`, subscription ID and observed
Pal ID; channel rows add `sourceKind: channel`, provider, connection and current
event actor. It prints no private message bodies. Acceptance does not mean the
model has read the input.
`dispatch` selects the oldest pending input across all families and runs one
eligible owned route with the recipient's pinned profile and
actual local computer. Its tools use **strict** review mode: only explicit
preapproved tool rules can authorize changes or replies without a reviewer.
Directed message consent does not approve guest writes, shell commands or the
send tool. Normal interactive Pal turns retain their existing review mode.

For example, an operator can separately preapprove `send_pal_message` through
the existing `permissions` config. The recipient and reverse route still require
their own directed grants; preapproving a tool alone cannot bypass those rules.

The same SDK durable input source receives arrivals during a running Pal
conversation at complete provider/tool boundaries. Cross-process notification
files are only wake hints; the inbox is authoritative. Stopped or idle receivers
retain their queue until explicitly dispatched. No perpetual listener, service
or automatic scheduled dispatcher is installed by these commands.
Unrelated notification changes do not settle a waiting conversation. Incoming
work blocked by an unfinished delivery reports a reconciliation error; it does
not start another provider call or silently restart the earlier task.

Execution rechecks current consent before inference and each tool effect.
The provider entry itself checks consent, covering revocation after iteration
events and auxiliary inference such as retries or compaction. Admission cleanup
always settles the send operation; failed release remains owned for close retry.
Revocation blocks new work; it does not undo already performed effects or erase
previously disclosed transcript context. An unknown prior append remains
`claimed` for verified recovery, rather than being retried as a new task.

Pal sessions and finite dispatch use the same SDK generic durable input source.
Observation delivery checks independent current observe, disclose and receive
permissions; idle wake additionally requires wake permission. A channel has no
implicit peer grant: CLI host composition must provide an explicitly trusted
connection/actor authorizer, otherwise channel receive and wake are denied.
External transport membership is not Pal Team membership.

Observation subscription configuration and permissions reside under
`pal-activity-subscriptions` and `pal-activity-subscription-policy`. These are
metadata/consent records; their inputs share `pal-message-inbox`, without a
second inbox. The finite CLI dispatcher owns its runtime cleanup and must not be
invoked as a cleanup owner inside a desktop process that shares that runtime.

State resides under `pal-message-policy`, `pal-message-inbox` and
`pal-message-wake` in the private Namzu home. The guest never mounts those
control directories. Existing conversations keep their claimed profile revision,
including routes accepted before a later profile edit. Notifications and
discovery do not publish another Pal's transcript.

## Finite activity subscriptions

```sh
namzu pal subscribe <source-pal-id> <source-conversation-id> <recipient-pal-id> [--wake] [--json]
namzu pal subscription <subscription-id> [--json]
namzu pal activity <subscription-id> [--max-records <n>] [--max-bytes <n>] [--causality-bytes <n>] [--causality-records <n>] [--json]
namzu pal unsubscribe <subscription-id> [--revision <n>] [--json]
```

`subscribe` is an explicit local operator consent action. It validates the
original source conversation and pinned profile, saves a disabled subscription,
grants observation/disclosure/receipt and then enables it with revision checking.
An interrupted setup remains disabled. Wake is false unless `--wake` is given;
publication never starts a computer or calls a model. Paused sources can be
observed. Profile edits do not change the captured source profile.

`subscription` displays the saved scope, destination, progress and current four
permission fields. `unsubscribe` disables that exact subscription using the
current revision, or an explicitly supplied expected revision. Already accepted
messages remain pending but cannot be delivered under disabled consent.

`activity` publishes one page of closed original metadata into the shared inbox,
then commits its host-stored cursor. Observation, disclosure and receipt are
checked independently and together again immediately before each acceptance;
revocation during an earlier check prevents new acceptance and cursor progress.
Defaults are 64 newly scanned records and
1 MiB of page reads; maxima are 256 records and 16 MiB. Causality verifies the
complete original prefix within separate defaults of 16 MiB and 100,000 records.
The corresponding flags accept positive integers; insufficient or incomplete
evidence rejects without progress. These journal read limits do not impose a
model token limit. Exact retries deduplicate accepted facts after interrupted
progress. No client cursor, transcript body or arbitrary observation text is
accepted.

The trusted [SDK causality resolver](../sdk/pal-subscriptions.md#verified-turn-causality)
requires the turn's first provider request and exact recorded observation
delivery receipts. A not-yet-recorded first request may need a later retry.
Verified observation feedback is suppressed; arbitrary peer/channel causality
is not inferred. Use `pal inbox` to inspect acceptance and `pal dispatch` for
separately authorized recipient execution. These commands install no daemon.
