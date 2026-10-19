---
"@namzu/sdk": minor
---

The `bash` tool now clamps a `timeout` above its maximum (`NAMZU_BASH_MAX_TIMEOUT_MS`, ten minutes by default) to that maximum instead of refusing the call. The command runs, and a timeout message reports the deadline that was applied. Nothing breaks for a caller that stayed under the maximum; a host that relied on the refusal to detect an over-long request should check `timeout` itself before calling.
