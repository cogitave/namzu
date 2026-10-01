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

A Pal's computer stays warm between turns and conversations in the same host
process. One conversation controls it at a time. Closing the host releases the
container and retains the Pal data volume. Unknown execution cancellation can
retire a computer; its current operation is refused until a confirmed stop and
restart. A failed stop keeps ownership tracked for retry.

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

This MVP has no autonomous resident loop or Pal Team. Manual compaction and
reopening a parked tool decision are not exposed in Pal terminal sessions yet.
A new user message can continue a settled or explicitly abandoned turn.

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
| `namzu/pals/conversations/claim` | `{ palId, sessionId }` | `{ sessionId, palId, revision }` |
| `namzu/pals/conversations/list` | `{ palId }` | Owned recent conversation rows, including empty ones |
| `namzu/pals/computer/status` | `{ palId }` | Computer availability |
| `namzu/pals/computer/start` | `{ palId }` | Ready computer identity |
| `namzu/pals/computer/stop` | `{ palId }` | Confirmed stopped state |
| `namzu/pals/computer/screen` | `{ palId }` | PNG data URL `source`, `width`, `height` |

Definitions have the [SDK PalDefinition shape](../sdk/pals.md). The computer
status has `status: 'ready' | 'stopped' | 'unavailable'`; ready includes
`environmentId` and string `generation`. Unavailable may include `notice` and
`requiresStop: true` when owned-resource cleanup must be retried. A screen is an
actual capture from the guest, never the operator desktop. Conversation rows
contain `id`, `title`, `named`, `updatedAt`, message `count` and `hasPrompted`.
Claim immediately after `session/new` and before history, settings or prompt
access. Ordinary session IDs and a different Pal's IDs confer no access.

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

`inbox` reports accepted message ID, source Pal ID, delivery status and owned
conversation ID. Acceptance does not mean the model has read the message.
`dispatch` runs one eligible owned route with the recipient's pinned profile and
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

State resides under `pal-message-policy`, `pal-message-inbox` and
`pal-message-wake` in the private Namzu home. The guest never mounts those
control directories. Existing conversations keep their claimed profile revision,
including routes accepted before a later profile edit. Notifications and
discovery do not publish another Pal's transcript.
