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

## Use it

- `/peers` or `/peers list`: show live terminals, short references, permission
  modes and the number of messages pending here.
- `/peers send <ref> <message>`: send text to the selected terminal.
- `/peers off`: refuse new mail and pause delivery of mail already accepted.
- `/peers on`: allow mail again; accepted pending mail can resume.

Participation starts on when the interactive application becomes ready. This
setting lasts for this terminal process. The model gets `list_sessions` and
`send_session_message`, using the exact live session id, short reference or
unambiguous title returned by discovery. Endpoint tokens are never returned to
the model. A live terminal id is separate from its durable conversation id;
resuming another conversation does not redirect that conversation's queued mail.

This is different from the existing `send_message` tool, which addresses an
owned child task in the current parent turn. Peer messaging cannot spawn,
restart, cancel or change another terminal's permissions.

## Delivery and authority

An idle, ready receiver starts a model turn for accepted peer context. During
work, mail enters history at the runtime's next provider-valid request boundary,
after the current tool batch or model response settles. It does not interrupt an
in-flight request or tool. Mail arriving during an apparent final response can
cause a further request. After a stopped or failed turn, or while a picker is
open, pending mail waits. A new operator instruction can resume the held queue;
peer mail cannot make that continuation decision.

The transcript attributes peer text to the other terminal. Durable history uses
`runtime-context/peer-message`; peer text is never an operator message or
approval. The receiving terminal retains its own rules, mode, budgets and
credentials. Automatic acceptance requires a verified live TUI sender in the
same project and the same permission mode. A different mode is refused rather
than treated as consent. Turning messaging on does not approve any tool call.

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
