---
"@namzu/sdk": patch
---

Preserve the recorded failure explanation in ACP `turn_ended.error` when a
provider fault pauses a turn at a checkpoint. Hosts can display the actual
failure instead of silently showing only a stopped turn. The existing coarse
`cancelled` category and exact `paused` reason remain compatible; ordinary
review pauses and user cancellation do not produce an error.
