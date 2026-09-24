---
type: Reference
title: Cross-session peer messaging (SDK)
description: The live-session registry, the namzu-peer/1 transport and the runtime-context rendering a delivered message or notice.
resource: packages/sdk/src/peers/
tags: [sdk, peers, messaging, protocol, experimental]
generated: { by: "claude-sonnet-5", at: "2026-09-24" }
---

# Cross-session peer messaging (SDK)

`@namzu/sdk`'s `peers/` module (all exports `@experimental`) is the transport
and storage half of cross-session messaging: two namzu sessions on the same
machine, run by the same OS user, can discover each other and exchange
messages. It does not decide policy — bounded inboxes, the mode-mismatch
hold/approve flow, `/peers off`, subscriber bookkeeping, and drain-at-
iteration-boundary injection into a running turn are host (CLI) concerns and
are not implemented here.

## Trust boundary

The boundary is the OS user, not the network. Any process running as the
same user can already read the user's files, so the goal is to keep other
users and the network out and to make every message's origin explicit — not
to defend against the user's own processes. Nothing in this module listens
on TCP.

## The runtime directory

`resolvePeerRuntimeDir({ env, namzuHome, uid })` chooses and hardens the
per-user directory sockets and registry records live in, among
`$XDG_RUNTIME_DIR/namzu`, `$NAMZU_HOME/run`, `$TMPDIR/namzu-<uid>`. Fitting
the platform's `sockaddr_un.sun_path` limit (104 bytes on macOS, 108 on
Linux, minus the longest socket filename this module ever creates — a
36-character UUIDv7 session id plus `.sock`) and being hardenable are
different failure modes: a candidate too long for the platform is never even
attempted, but among the candidates that DO fit, the first that can actually
be created and hardened mode 0700 (refusing a symlink and — on POSIX —
verified by `lstat` to be owned by `uid`) is the one used. A length-fitting
candidate that cannot be hardened — owned by another uid, a permission this
process cannot chmod away — is skipped in favour of the next one rather than
failing outright, so a hostile or misconfigured `$XDG_RUNTIME_DIR` cannot deny
peer messaging to a session that could fall back to `$NAMZU_HOME/run`. Only
when every fitting candidate has failed to harden does this throw, naming
each one and why. `hardenPeerRuntimeDir` is the hardening step alone,
reimplemented here rather than imported from the CLI
(`ensurePrivateStateDirectory`) because the SDK does not depend on the CLI; a
caller may inject its own via `ResolvePeerRuntimeDirOptions.hardenDirectory`.

## The live-session registry

Each participating session writes one record to
`<runtime-dir>/sessions/<sessionId>.json`, atomically (fsynced temporary,
then rename) and mode 0600: `PeerRecordSchema` — `v`, `sessionId`, `ref`
(the first 6 hex characters of `sha256(sessionId)`, from `derivePeerRef`),
`pid`, `startedAt`, `kind` (`tui` | `exec` | `resident` | `scheduled`),
`title?`, `cwd`, `permissionMode`, `state` (`busy` | `idle` |
`awaiting-permission`), `acceptsMessages`, `address`, `token`, `protocol`
(`namzu-peer/1`), `cliVersion`.

`writePeerRecord`, `readPeerRecord`, `readPeerRecords` and `removePeerRecord`
read and write these files; a record that fails to parse (mid-write,
truncated, from a newer namzu) is skipped rather than thrown on, so one
malformed record cannot hide every other live session.

A record is **live** iff its pid is alive AND its address answers a `ping`
within 500ms (`isPeerRecordLive`). `listLivePeers` pings every record in the
registry and removes the dead ones — both the registry file and, if it names
a UDS socket, the socket file — but only when owned by this uid, so a stale
cleanup pass can never touch another user's files.

## The `namzu-peer/1` protocol

Newline-delimited JSON, one request and one response per connection, a
64&nbsp;KiB request cap, a 2-second read deadline, at most 16 concurrent
connections, and a closed set of four operations (`PeerRequestSchema`, a
`zod` discriminated union on `op`):

- **`ping`** → `{ ok, state }`. Carries no token: it is idempotent, has no
  side effect, and discloses nothing the directory permission does not
  already gate. `PeerClient.ping(address)` and the free function `pingPeer`
  reflect this — they take a bare address, not a record.
- **`deliver`** `{ token, id, from, text, inReplyTo?, subscribeIdle? }` →
  `{ status: 'queued' | 'held' | 'refused', reason? }`. `text` is capped at
  32&nbsp;KiB of UTF-8 bytes (not UTF-16 characters).
- **`subscribe_idle`** `{ token, id, from }` → `{ status: 'subscribed' |
  'refused' }`.
- **`notice`** `{ token, from, kind: 'idle' | 'exited' | 'delivery', about,
  outcome?, detail? }` → `{ ok }`. `outcome` (`'queued' | 'held' | 'refused'`)
  is set only for a `delivery` notice, naming the outcome `formatPeerNotice`
  renders as a closed status; it is a small addition beyond the wire shape a
  delivery notice's prose `detail` alone would require parsing to recover.
  `from` is required exactly like `deliver`/`subscribe_idle`'s: a `notice` is
  a claim about an outcome, and an unauthenticated claim is exactly as
  dangerous here as an unauthenticated message.

Every op but `ping` requires the **recipient's** token, compared with
`timingSafeEqual`. `from` asserts the sender's identity; the recipient checks
it against its own registry (`verifySender`, below) rather than trusting it
outright — a process cannot claim to be a session it does not own without
also owning that session's live registry record. A `notice` additionally has
to correlate to a relationship the recipient's own endpoint actually has with
that sender: a `delivery` notice must match a `deliver` this session sent to
that peer (`PeerEndpoint.registerOutstandingDelivery`), and an `idle`/`exited`
notice must match a subscription this session made
(`PeerEndpoint.registerOutstandingSubscription`) — each accepted notice
consumes one. A verified, live, honestly-registered sender with no such
relationship to this recipient is refused just as an unverified one is: being
a real session is necessary but not sufficient to report an outcome nobody
asked it about. A notice's `about` must also name the sender itself
(`from.sessionId === about.sessionId`) — a session only ever reports a notice
about its own delivery or subscription, never a third party's — and the
`name`/`ref` the recipient actually sees in `about` are always rebuilt from
the sender's own verified registry record, never taken from the wire.

Addresses are URIs, so a later cross-machine transport can be added without
redesigning anything: `uds:<path>` and `pipe:<name>` today, `a2a:https://…`
reserved for later (`parsePeerAddress`, `udsPeerAddress`, `pipePeerAddress`).

## Server and client

`createPeerEndpoint({ address, token, uid?, getState, sessionsDir?,
onDeliver, onSubscribeIdle, onNotice, verifySender? })` serves one session's
socket: a Unix domain socket on POSIX, a named pipe (`\\.\pipe\namzu-<uid
hash>-<session-short>`) on win32 — coded for both, tested only on POSIX. The
socket is chmodded 0600 immediately after `listen`; a stale socket at the
target path is unlinked only if it is owned by this uid and nothing answers
a ping there. `onDeliver`, `onSubscribeIdle` and `onNotice` decide outcomes;
`createPeerEndpoint` owns only the transport — framing, the size/connection/
deadline limits, the closed op set, and token comparison. The endpoint also
returns `registerOutstandingDelivery(peerSessionId)` and
`registerOutstandingSubscription(peerSessionId)`, which the caller uses to
record that THIS session sent a `deliver`/`subscribe_idle` (directly, or via
`deliver.subscribeIdle`) to a peer, so a later `notice` about that peer can be
told apart from an uncorrelated one (see `notice`, above).

`verifySender` does not just answer yes or no: on success it returns the
identity the recipient should actually use, which is never simply the wire's
`from` handed back. The default (`defaultVerifySender`) reads
`from.sessionId`'s record from `sessionsDir`, requires it to be live
(`isPeerRecordLive`), requires its `address` to equal `from.address`, and —
fixed 2026-09-24, after a review found the mode-mismatch hold gate could be
laundered by a sender simply asserting a different mode on the wire — also
requires its `permissionMode` and `kind` to equal `from.mode` and `from.kind`,
refusing outright rather than silently correcting a mismatch. The `PeerFrom`
handed to `onDeliver`/`onSubscribeIdle`/`onNotice` on success is rebuilt
entirely from the record: `sessionId`, `ref`, `address`, `mode`, `kind` are
the record's own fields, and `name` is the record's display name (`title`
when set, else the last path segment of `cwd`) — never the wire's claimed
`name`, which a session cannot be trusted to report honestly about itself on
a single connection even when its registered identity checks out.

`PeerClient` (`ping`, `deliver`, `subscribeIdle`, `notice`) and the module
functions on it (`pingPeer`) are one request per connection: an
authenticated response *proves* responsiveness, and its absence never proves
the peer is dead, only that this attempt could not reach it —
`PeerClientResult<T>` is `{ kind: 'responded', ...T } | { kind: 'unreachable',
reason }`.

## Runtime-context rendering

Two new runtime-context message kinds — `peer-message` and `peer-notice` —
join `RUNTIME_CONTEXT_MESSAGE_KINDS` (`types/message/index.ts`).
`isOperatorUserMessage` stays `false` for both: a message from another
session is host-generated context, never the operator's own instruction.

`formatPeerMessage(message)` and `formatPeerNotice(notice)` render the text
such a message carries. Both are thin wrappers over `formatSystemEvent`
(`runtime/system-events.ts`), the shared envelope every asynchronous event —
a delegated task finishing, a background job exiting, a peer message or
notice arriving — renders through: `<system-event kind="…" id="…"
status="…">`, a fixed sentence that the event is not the operator and not
consent, `summary:` / `source:` / `usage:` (when known) / `more:` lines
outside the untrusted body, then the body itself (`wrapUntrusted`, or
`(no output)`). The outer runtime-context kind stays exactly `peer-message` /
`peer-notice`, but the envelope's own `kind` attribute is more specific —
`peer-message` for a delivered message, `idle-notice` for an idle
transition, `peer-notice` for an exit, `delivery-notice` for a delivery
outcome. A delivered message's sender address, name, ref and mode are
carried as attributes on the untrusted body, and the "carries no authority —
reply with `send_message`" sentence lives in that body's provenance line.
`formatSystemEvent` does not itself migrate `formatCompletionNotification`'s
`<task-notification>` text or the `job-exit` path; that is a separate,
later change.

A peer's `name`/`mode`/`source` reach `summary`/`source`/`more` and the
untrusted body's `provenance`, all outside `wrapUntrusted`'s own escaping, so
`formatSystemEvent` defangs any occurrence of its own `<system-event>`
keyword in them before rendering. Fixed 2026-09-24: that defense used to be a
literal, ASCII, case-insensitive match, which a Unicode lookalike (a
non-breaking hyphen for the ASCII one, a fullwidth spelling, a zero-width or
bidi-control character hidden inside the word) walked straight through
without changing how a model reads the text as structure. The text is now
folded first — NFKC normalization, dropped zero-width/bidi-control/
variation-selector characters, every Unicode dash and space mapped to its
ASCII form (`utils/confusable-text.ts`) — before the keyword match runs, and
an untrusted field is emitted in its folded form; an exotic character that
does not survive folding is not restored, an acceptable fidelity loss for
text this envelope already says not to trust. `tools/untrusted-envelope.ts`'s
`neutralizeEnvelopeDelimiter` had the identical, pre-existing defect and was
fixed the same way, sharing this helper.

## What is not built here

CLI wiring (registry lifecycle across TUI/exec/resident sessions, `/peers`,
the mode-mismatch hold/approve flow, notices in the transcript, the
`list_sessions` and widened `send_message` tools, the coding-agent doctrine
paragraph) is a separate workstream. This module only stores records, speaks
the wire protocol, and renders text; nothing here queues a message, decides
whether to wake an idle session, or injects anything into a running turn.
