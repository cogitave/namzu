---
'@namzu/sdk': major
---

Bound `LocalExecutionContext` command output to 4 MiB per stdout/stderr stream. The previous default retained unlimited output in memory. Consumers that require a larger result must set the new finite `maxOutputBytes` option, up to the 64 MiB per-stream hard ceiling.

`CommandResult` now exposes optional `stdoutTruncated` and `stderrTruncated` facts. The built-in local context always reports both booleans; absent flags from custom and remote executors remain unknown. Workspace fingerprinting refuses partial command results, while failed command gates name which diagnostic streams were truncated.

Hybrid configuration serialization now preserves its local `capabilities`, `shell`, and resolved `maxOutputBytes`. Consumers that deep-compare serialized Hybrid configs must account for those fields.
