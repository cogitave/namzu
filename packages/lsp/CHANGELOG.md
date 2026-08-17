# @namzu/lsp

## 0.2.0

### Minor Changes

- 9914794: New optional package `@namzu/lsp`: language-server-backed code navigation, so an agent asked for the call sites of a function gets symbol resolution rather than regex matches.

  The whole navigation surface a namzu agent had was `grep` and `glob`. Ask for every call site of `computeTotal` and you get the comment that mentions it, the string literal that names it, and the unrelated same-named function in another scope — and you **miss** the call site that arrives through a re-export or a destructure, which is exactly the one a rename has to get right.

  `StdioCodeNavigationProvider` drives one language server over its stdin and stdout: `Content-Length` framing (not JSON lines — a response carrying source text contains newlines), the `initialize`/`shutdown` handshake, request correlation, `textDocument/definition` and `textDocument/references`.

  **Three answers, not two.** `unsupported` means the server does not implement the operation, so a caller can fall back to `grep` and _say_ the answer is textual; `failed` means something broke and the answer is unknown. Neither is `{ kind: 'locations', locations: [] }`, which means "I looked, and there are none" — the answer a deletion depends on. A provider that answered a missing binary with an empty list would tell an agent a symbol has no callers, and the agent would delete it. So a server that never completes `initialize` produces `failed` naming the binary, within a bounded startup timeout, and the failure is remembered rather than respawning a process per call.

  In `@namzu/sdk`: an `lsp` builtin, `CodeNavigationProvider` on `ToolContext` the way `sandbox` already arrives, and `getCodeNavigationTools(provider)` which returns **an empty array when there is no provider**. The tool is not registered at all in a run that cannot use it — one that is always present and always answers "unavailable" costs a decision on every turn to say nothing, and teaches a model a capability exists when it does not.

  Every path is contained through `resolveWithinReal` before it reaches the server, the same containment `read` and `grep` use. A language server indexes a workspace and will answer about anything it is handed; the boundary is the tool's job.

  `dispose()` sends the shutdown handshake before killing, so a server holding a lock file or mid-write on an index gets to finish, and falls back to `SIGKILL` on a bounded timeout so one that ignores `exit` cannot keep the run alive.

- 655cc9d: Code navigation gains `hover` and `symbols`, and routes by file extension so a repository can have more than one language.

  **`symbols` is the entry point, and its absence made the rest unreachable.** `definition` and `references` both need a line and a character, and an agent starting from a name has neither — so every navigation began with a grep, which is the text path this package exists to replace, reintroduced as a prerequisite. `symbols(query, scope?)` finds a declaration by name with no position at all.

  `hover(file, line, character)` gives a symbol's resolved type and documentation without opening the file. Its `contents` may be **empty**, and that is a real answer: hovering over whitespace or a comment resolves to nothing, and a caller has to be able to tell that from a server that broke.

  **Capabilities are READ from the initialize result, never probed.** A server with a workspace index answers `workspace/symbol`; one with only document symbols falls back to `textDocument/documentSymbol`; one declaring neither returns `{ kind: 'unsupported' }` naming both missing capabilities. Sending the request and interpreting whatever error comes back works until a server answers an error for a transient reason, and the fallback then fires for a capability the server has. The `documentSymbol` reply is a tree and is walked — a reader that took only the top level would miss every method, which is most of what a name search is for.

  **`RoutingCodeNavigationProvider` maps extension to server**, starting one lazily per language on first use and reusing it. A file whose extension maps to nothing gets `{ kind: 'unsupported' }` naming the extension — not a default server, which would send the file to something that cannot read it and answer nothing, which reads as a symbol with no references. A `symbols` call with no scope asks every configured language, and reports `unsupported` rather than an empty list when every server refused, because "nobody looked" is not "the name does not exist".

  The `lsp` builtin's input is a discriminated union: position is **required** for `definition`/`references`/`hover` and **absent** for `symbols`. Making it unconditionally optional lets a `definition` with no line silently resolve the top of the file; making it unconditionally required forces a `symbols` call to invent two numbers.

## 0.2.0

### Minor Changes

- 9914794: New optional package `@namzu/lsp`: language-server-backed code navigation, so an agent asked for the call sites of a function gets symbol resolution rather than regex matches.

  The whole navigation surface a namzu agent had was `grep` and `glob`. Ask for every call site of `computeTotal` and you get the comment that mentions it, the string literal that names it, and the unrelated same-named function in another scope — and you **miss** the call site that arrives through a re-export or a destructure, which is exactly the one a rename has to get right.

  `StdioCodeNavigationProvider` drives one language server over its stdin and stdout: `Content-Length` framing (not JSON lines — a response carrying source text contains newlines), the `initialize`/`shutdown` handshake, request correlation, `textDocument/definition` and `textDocument/references`.

  **Three answers, not two.** `unsupported` means the server does not implement the operation, so a caller can fall back to `grep` and _say_ the answer is textual; `failed` means something broke and the answer is unknown. Neither is `{ kind: 'locations', locations: [] }`, which means "I looked, and there are none" — the answer a deletion depends on. A provider that answered a missing binary with an empty list would tell an agent a symbol has no callers, and the agent would delete it. So a server that never completes `initialize` produces `failed` naming the binary, within a bounded startup timeout, and the failure is remembered rather than respawning a process per call.

  In `@namzu/sdk`: an `lsp` builtin, `CodeNavigationProvider` on `ToolContext` the way `sandbox` already arrives, and `getCodeNavigationTools(provider)` which returns **an empty array when there is no provider**. The tool is not registered at all in a run that cannot use it — one that is always present and always answers "unavailable" costs a decision on every turn to say nothing, and teaches a model a capability exists when it does not.

  Every path is contained through `resolveWithinReal` before it reaches the server, the same containment `read` and `grep` use. A language server indexes a workspace and will answer about anything it is handed; the boundary is the tool's job.

  `dispose()` sends the shutdown handshake before killing, so a server holding a lock file or mid-write on an index gets to finish, and falls back to `SIGKILL` on a bounded timeout so one that ignores `exit` cannot keep the run alive.
