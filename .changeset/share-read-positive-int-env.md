---
"@namzu/sdk": patch
---

`bash`'s and the delegation coordinator's private copies of `readPositiveIntEnv` are gone; both now import the one already shared with `wait_for_job` and the iteration runtime. Each call site still samples its environment variable at the same point it always did — module load for `NAMZU_BASH_TIMEOUT_MS`, `NAMZU_BASH_MAX_BUFFER_BYTES`, `NAMZU_BASH_MAX_TIMEOUT_MS` and `NAMZU_DELEGATION_IDLE_MS` — so no knob starts reading its variable at a different time. No behavior, schema or default changed.
