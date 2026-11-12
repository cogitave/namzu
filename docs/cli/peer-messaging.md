---
type: Reference
title: Messages between live terminals
description: Discover and message independent interactive sessions in one project.
resource: packages/cli/src/integrations/peers/runtime.ts
tags: [cli, sessions, messaging]
---

# Messages between live terminals

Two ready interactive Namzu terminals in the same canonical project can discover
each other and exchange messages. Each terminal owns a local endpoint; no server,
scheduler or A2A connection is needed. The SDK's experimental
[peer transport](../sdk/peer-messaging.md) handles authenticated local sockets on
POSIX and named pipes on Windows. The Windows path is implemented but has not
been exercised on a Windows host in this change.

Both terminals must use the same user-local runtime directory selected by the
SDK. The operating-system account owns that registry; project and mode checks
are application policy. Environment isolation remains a separate deployment
choice.

## Use it

- `/peers` or `/peers list`: show live terminals, short references, permission
  modes and the number of messages pending here.
- `/peers send <ref> <message>`: send text to the selected terminal.
- `/peers off`: refuse new mail and pause delivery of mail already accepted.
- `/peers on`: allow mail again; accepted pending mail can resume.

## From a command line

`namzu peers` reaches a live terminal without opening one, for a script or a second shell in the same folder:

```sh
namzu peers list [--json]
namzu peers send <ref|id|title> <message...> [--json] [--mode <mode>] [--file <path>|-]
```

`list` prints the live terminals in this project: reference, title, state and permission mode. `send` takes the message as words, or from `--file` (`-` reads standard input) to keep line breaks and any language intact; words and `--file` do not mix. Flags may stand anywhere, and `--` ends them.

The command is a short-lived sender with its own identity: it writes a `cli` record in the same registry, listens only for the receiver's check, and removes the record when it exits. The receiver applies the same rules as for a terminal: same canonical project, same account and runtime directory, same permission mode. `--mode` states the mode this command acts under; without it, the mode a new terminal would start in here (`permissions.defaultMode`, else `prompt`). A different mode is refused, including `bypass`. The mail reaches the model as from a command-line sender, not a terminal, and never as operator text or approval. A command-line sender takes no messages and is not listed.

The receipt is printed in words. With `--json`, `send` prints one JSON object: `status` (`queued`, `refused` or `unreachable`), `reason`, `mode`, and, when known, `ref`, `id` and `sessionId` (the target's; present once the command reached the delivery step). `mode` is the internal mode name, so the flag value `auto` appears as `classify`. `list --json` prints `{"peers":[{"ref","sessionId","title","state","mode","acceptsMessages"}]}` with the same internal `mode` names, never tokens or addresses. With `--json`, a usage, input or availability error is one object `{"error":"...","exit":<code>}` on standard output instead of text.

| Receipt | Meaning | Exit |
|---|---|---|
| Queued | Accepted into the live inbox, not proof the model read it. | 0 |
| Refused | The terminal or the command declined, with the reason. | 1 |
| Unreachable | No terminal answered; acceptance is unknown, do not retry blindly. | 69 |

Bad arguments or an empty message exit 64, input that is not UTF-8 text (or contains NUL) exits 65, and an unreadable file exits 66. A `--file` input is read only up to one byte past 32 KiB, so an endless pipe or huge file is refused without being buffered. A message over 32 KiB, or one that is over the 64 KiB request limit once quotes and control characters are escaped, is refused (exit 1) before anything is sent. The `/peers send` slash command collapses runs of whitespace; `namzu peers send --file` does not.

Participation starts on when the interactive application becomes ready. This
setting lasts for this terminal process. The model gets `list_sessions` and
`send_session_message`, using the exact live session id, short reference or
unambiguous title returned by discovery. A terminal's title is the name of its
conversation (the one you gave it with `/rename`, else the one the small model
wrote, at most 40 characters on one line) and the folder's name until it has
one; a rename reaches the live record at once, so two terminals in one folder
tell each other apart by more than a reference. Endpoint tokens are never returned to
the model. A live terminal id is separate from its durable conversation id;
resuming another conversation does not redirect that conversation's queued mail.

This is different from the existing `send_message` tool, which addresses a
child task of the current conversation, from any of its turns, including one saved by an earlier run of the program. Peer messaging cannot spawn,
restart, cancel or change another terminal's permissions.

## A person's message is not an agent's

`namzu send <session> <message>` (and the `m` key in `namzu watch`) says something
to a running session as **the person**, not as another agent. It uses this page's inbox
and endpoint, and differs in the ways that matter:

| | Another session or `namzu peers send` | `namzu send` |
|---|---|---|
| Addressed by | live terminal reference, id or title, in this folder | the conversation's id, as `namzu watch` names it, in any folder of the account |
| Sender's kind | `tui` or `cli` | `person` |
| Permission mode | must equal the receiver's, or it is refused | not compared: a person has no mode to match, and the message cannot change the receiver's |
| The model is told | it carries no authority, not the operator's instruction | it is the person's own words from another terminal: not another agent, not a tool result, not an approval |
| Recorded as | `peer-message` | `person-message` ("Message from you, typed at another terminal") |
| Sent from inside a session | allowed: that is what an agent is | refused: a person's message is not from a tool or agent (checked by the process tree on both ends; [the limit](watching-a-session.md#not-from-a-tool-or-an-agent)) |
| Answer | queued, refused or unreachable | delivered, accepted, refused, unreachable or not found; "delivered" is said by the receiving process once it takes the message |

What the person's message shares with an agent's: the 32-message inbox, 32 KiB text
limit, request boundaries and idle wake, the hold while a picker is open or after a
stopped turn, discard on a change of conversation (not of mode), and that it can never
answer an approval or a question, change the permission mode or be run as a command.
It also names the conversation it means, and a terminal that has moved to another
conversation refuses it. See [Watching a session from another terminal](watching-a-session.md#saying-something-to-the-session)
for the answers and exit statuses.

## Delivery and authority

An idle, ready receiver starts a model turn for accepted peer context. During
work, mail enters history at the runtime's next provider-valid request boundary,
after the current tool batch or model response settles. It does not interrupt an
in-flight request or tool. Mail arriving during an apparent final response can
cause a further request. After a stopped or failed operator or peer turn, or
while a picker is open, pending mail waits. A new operator instruction can
resume the held queue; peer mail cannot make that continuation decision.
Automatic goal rounds retain their separate goal-driver continuation policy.

The transcript attributes peer text to the other terminal. Durable history uses
`runtime-context/peer-message`; peer text is never an operator message or
approval. The receiving terminal retains its own rules, mode, budgets and
credentials. Automatic acceptance requires a verified live TUI sender in the
same project and the same permission mode (a terminal, or a command-line sender from `namzu peers send`). A different mode is refused rather
than treated as consent, including when the receiver uses bypass mode. The
receiver checks its current mode again before an idle wake consumes mail and
before busy-turn delivery. If the mode changes after acceptance, incompatible
pending mail is discarded with a local notice, not replayed under the new mode;
returning to the previous mode does not revive it. A queued receipt therefore
remains an acceptance receipt, not a promise of later delivery. Turning messaging
on does not approve any tool call.

The response is **queued**, **refused**, or **unreachable**. Queued means accepted
into the live inbox, not understood or completed. No receipt after a send means
acceptance may be unknown; there is no automatic retry. A bounded window of 256
sender/message-id pairs suppresses duplicate acceptance in the same live
instance. This is not an exactly-once execution guarantee.

The inbox holds at most 32 messages, each at most 32 KiB of UTF-8 text. Accepted
mail belongs to the current conversation generation; changing conversations
discards stale pending mail with a local notice. Mail is process-local until it
enters history: a crash can lose it. Closing invokes the local undelivered-mail
report callback and removes the endpoint; it does not send a delivery proof to
the sender. Durable external tasks, idle subscriptions and mode-mismatch
approval dialogs are not supplied by this host integration.
