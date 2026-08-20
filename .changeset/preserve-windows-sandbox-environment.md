---
'@namzu/sdk': patch
---

Preserve the non-secret Windows core environment when `LocalSandboxProvider` launches a child. Windows environment names now merge case-insensitively, so session and per-call overrides replace ambient variants deterministically, while POSIX sandbox and MCP inheritance policies remain unchanged.
