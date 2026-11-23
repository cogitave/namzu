---
'@namzu/sdk': minor
---

A machine that asks to join a Namzu network now asks once, however many terminals it runs. The request in flight and how the last one ended are kept in `network/join-attempt.json` (every terminal of the machine reads it): a repeat reuses the request's nonce, so the member shows the same request and code, and after a Deny the service does not ask that network again on its own for 60 minutes (10 minutes after a request that expired unanswered or was refused). A member keeps at most one waiting request per machine, no longer ends a request when its connection drops, and accepts a new pre-membership operation `join_cancel` (no fields) with which the joining machine withdraws its request; an older member answers it as an unknown operation and the request waits out its ten minutes. `NetworkStore` gains `readJoinAttempt`, `writeJoinAttempt` and `clearJoinAttempt`. Nothing to change in a caller; `NetworkService.join(address)` still asks at once.
