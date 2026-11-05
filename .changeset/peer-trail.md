---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A live peer record can now carry `trail`: up to four exchanges the terminal has just taken part in, each `{ with, dir, at }` (the other terminal's `ref`, `in` or `out`, and when). It names who talked and never what was said. `PeerExchange` and `PEER_TRAIL_MAX` are exported. A terminal inside a workspaces host writes it when it sends or accepts a peer message, and `namzu workspaces` shows it for four seconds on both sessions' rows as `→ name` and `← name` with a beating dot (still, in words, with reduced motion or no colour). A plain terminal writes no `trail`, so builds that predate the field still read its record.
