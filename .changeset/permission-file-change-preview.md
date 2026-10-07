---
"@namzu/sdk": minor
---

Add `dryRunEdit(content, input)` and the `AcpFileChangePreview` type, and let each tool call in a `session/request_permission` request carry an optional `preview` (`{ path, before, after }`) that the bridge forwards untouched. `dryRunEdit` runs the `edit` tool's own schema and apply code (single replacement, `replace_all`, `edits[]`, `insertLine`) on a string, so a host can show exactly what an approved edit will write without touching the file. `resolveWithinAnyReal` is now exported beside `resolveWithinReal`. Nothing existing changes: a client that ignores `preview` and an agent that never sets it behave as before.
