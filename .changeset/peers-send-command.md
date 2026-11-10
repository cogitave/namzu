---
'@namzu/cli': minor
'@namzu/sdk': minor
---

Add `namzu peers list` and `namzu peers send <ref|id|title> <message...>` to message a live terminal in the same project from a command line, with `--json`, `--mode <mode>` and `--file <path>|-`. The message is attributed to a command-line sender, never to the operator, and the receiver still refuses a different permission mode. Exit 0 queued, 1 refused, 69 unreachable, 64 bad arguments. A terminal now also accepts mail from a verified `cli` sender in its own project. The SDK's `PeerSessionKind` gains `cli`, so a consumer that switches exhaustively over it adds a case; the peer message provenance text differs for that kind.
