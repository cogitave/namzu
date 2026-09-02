---
"@namzu/cli": patch
---

`namzu run-stream` no longer waits forever on a pipe that is open and silent. It read stdin to end-of-input whenever stdin was not a terminal, so a host that spawned it without closing stdin — a background task, a CI step, a UI that forgot — saw the boot log stop and nothing follow. It now takes the same quarter-second first-byte deadline `namzu run` already used: data that is there is read in full, silence means no history.
