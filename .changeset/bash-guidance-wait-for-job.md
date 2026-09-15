---
"@namzu/sdk": patch
---

`bash`'s own `timeout` and `run_in_background` parameter descriptions no longer tell the model to "poll with the `job` tool" — they now point at `wait_for_job` (one call, no waiting turns) the same way `job`'s own description already does, and reserve `job` with action `"read"` for incremental output or picking up after a `wait_for_job` timeout. The tool result returned when a background job starts is worded the same way. No schema, behavior or tool-result shape changed.
