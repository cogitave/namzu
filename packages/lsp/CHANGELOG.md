# @namzu/lsp

## 0.3.1

### Patch Changes

- dd43d9f: Reject in-flight and future navigation calls immediately when a language
  server's stdio transport closes after startup, while retaining ownership of
  the child process for bounded disposal.

## 0.3.0

### Minor Changes

- 03e363c: Declare the Node floor these packages already had, and export a type `TelemetryConfig` already required.

  **`engines.node: ">=20.0.0"`.** Only `@namzu/cli` declared one; the other fourteen published without any, so npm could not warn a consumer installing onto an unsupported runtime — they got a crash at some later import instead. The floor is not new: `@namzu/cli` has declared it since it shipped and `install.sh` has enforced it since it existed. This makes the other fourteen say the same thing.

  If you install with `engine-strict=true` on Node 18, an install that previously emitted nothing will now fail. Upgrade to Node 20 or newer, which the code already assumed. Everyone else sees no change, or an `EBADENGINE` warning that replaces a later crash.

  Worth stating plainly: CI verifies Node 22 and 24. The 20 floor is a declared minimum, not a tested one.

  **`SpanProcessorLike` is now exported from `@namzu/telemetry`.** `TelemetryConfig.spanProcessors` takes `readonly SpanProcessorLike[]`, and the type had no export — a field on the public surface whose type was not on it, so a host supplying the value had to inline the shape or reach for `any`.

## 0.2.1

### Patch Changes

- 075dfdf: Stop the README from making the package unpublishable.

  A paragraph documenting the tool's path-containment boundary named a traversal path literally. npm's registry sits behind a WAF whose managed rules match path-traversal signatures in a request body, and `npm publish` sends the README as part of that body — so every publish of this package was rejected with a generic `403 Forbidden` about permissions, from CI and from a maintainer's machine alike. The prose is the payload; the text now describes traversal without spelling one, and says so in place so nobody puts it back.

  This is why `@namzu/lsp` has no released versions before `0.2.0` despite being in the repository since 2026-08-16.

- b2c005c: Make each README an npm package page rather than the package's manual.

  `@namzu/sdk`'s README was a twenty-four-section architecture tour, 45 KB of it; the others ran to several hundred lines each. That is the right shape for a single-package repository, where the README _is_ the documentation, and the wrong one here — it duplicated a `docs/` tree that already existed, and nothing checked that the two agreed.

  Each README is now what a reader needs in the first minute: what the package is, install with its Node requirement, one working example, and links. The long-form material moved into `docs/` whole — `docs/sdk/architecture.md`, `docs/cli/reference.md`, `docs/packages/<name>.md` — where the doc gates cover it.

  Two documentation defects fell out of the move, both in `@namzu/telemetry`'s session-export example, and both had been shipping: the config field is `redactors` and takes a list, not `redactor` taking one; and `secretRedactor` is a factory that has to be called. The required `destination` field was missing from the example entirely. They surfaced because a README is gated by nothing and `docs/` is compiled against the built SDK.

  No API change.

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
