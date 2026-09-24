---
"@namzu/sdk": minor
---

Cross-session peer messaging, SDK half (`@experimental`): two namzu sessions run by the same OS user can now discover each other and exchange messages over a local socket.

New `packages/sdk/src/peers/` module: `resolvePeerRuntimeDir` (a hardened per-user runtime directory, with a `$TMPDIR/namzu-<uid>` fallback when the preferred path is too long for the platform's Unix-domain-socket limit), the live-session registry (`PeerRecordSchema`, `writePeerRecord`/`readPeerRecord`/`readPeerRecords`/`removePeerRecord`, `derivePeerRef`, `listLivePeers`/`isPeerRecordLive`), the `namzu-peer/1` wire protocol (`PeerRequestSchema` and friends: `ping`/`deliver`/`subscribe_idle`/`notice`, a closed op set, newline-delimited JSON, a 64 KiB request cap, a 2-second read deadline, at most 16 concurrent connections, `timingSafeEqual` token comparison), `createPeerEndpoint` (a UDS server on POSIX; a named-pipe server is written for win32 but not exercised by this package's tests) and `PeerClient`/`pingPeer`.

Two new SDK-visible pieces:

- `RUNTIME_CONTEXT_MESSAGE_KINDS` gains `peer-message` and `peer-notice`; `isOperatorUserMessage` (internal) stays `false` for both, so a message from another session is never treated as operator intent.
- `formatSystemEvent` (`packages/sdk/src/runtime/system-events.ts`): one shared envelope for an asynchronous event a running turn reads as context — `<system-event kind="…" id="…" status="…">`, a fixed sentence that the event is not the operator and not consent, `summary`/`source`/`usage`/`more` metadata, then the untrusted body. `formatPeerMessage`/`formatPeerNotice` render through it. This does not migrate the existing `formatCompletionNotification` (`<task-notification>`) text or the `job-exit` path — that is a separate change.

Everything here is transport and storage only. CLI wiring — registry lifecycle across TUI/exec/resident sessions, the mode-mismatch hold/approve flow, `/peers`, `list_sessions`, a widened `send_message` — is a later, separate change; nothing in this release queues a message, wakes an idle session, or injects anything into a running turn on its own.
