---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add authenticated Pal channel ingress with captured host connections, a fresh actor per event, immutable native conversation targets, and shared durable inbox delivery. Recorded reply and action routing verifies the original owned conversation receipt and current authority; it does not send remote messages automatically. Hosts must provide a trusted event verifier and explicit receive, wake, reply and action policy. The CLI includes a private local HMAC fixture adapter and a bridge to exact native parked tool-review actions; other channel actions remain unsupported.
