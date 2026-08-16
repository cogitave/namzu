---
'@namzu/lsp': minor
'@namzu/sdk': minor
---

New optional package `@namzu/lsp`: language-server-backed code navigation, so an agent asked for the call sites of a function gets symbol resolution rather than regex matches.

The whole navigation surface a namzu agent had was `grep` and `glob`. Ask for every call site of `computeTotal` and you get the comment that mentions it, the string literal that names it, and the unrelated same-named function in another scope — and you **miss** the call site that arrives through a re-export or a destructure, which is exactly the one a rename has to get right.

`StdioCodeNavigationProvider` drives one language server over its stdin and stdout: `Content-Length` framing (not JSON lines — a response carrying source text contains newlines), the `initialize`/`shutdown` handshake, request correlation, `textDocument/definition` and `textDocument/references`.

**Three answers, not two.** `unsupported` means the server does not implement the operation, so a caller can fall back to `grep` and *say* the answer is textual; `failed` means something broke and the answer is unknown. Neither is `{ kind: 'locations', locations: [] }`, which means "I looked, and there are none" — the answer a deletion depends on. A provider that answered a missing binary with an empty list would tell an agent a symbol has no callers, and the agent would delete it. So a server that never completes `initialize` produces `failed` naming the binary, within a bounded startup timeout, and the failure is remembered rather than respawning a process per call.

In `@namzu/sdk`: an `lsp` builtin, `CodeNavigationProvider` on `ToolContext` the way `sandbox` already arrives, and `getCodeNavigationTools(provider)` which returns **an empty array when there is no provider**. The tool is not registered at all in a run that cannot use it — one that is always present and always answers "unavailable" costs a decision on every turn to say nothing, and teaches a model a capability exists when it does not.

Every path is contained through `resolveWithinReal` before it reaches the server, the same containment `read` and `grep` use. A language server indexes a workspace and will answer about anything it is handed; the boundary is the tool's job.

`dispose()` sends the shutdown handshake before killing, so a server holding a lock file or mid-write on an index gets to finish, and falls back to `SIGKILL` on a bounded timeout so one that ignores `exit` cannot keep the run alive.
