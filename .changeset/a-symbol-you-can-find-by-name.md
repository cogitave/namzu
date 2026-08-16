---
'@namzu/lsp': minor
'@namzu/sdk': minor
---

Code navigation gains `hover` and `symbols`, and routes by file extension so a repository can have more than one language.

**`symbols` is the entry point, and its absence made the rest unreachable.** `definition` and `references` both need a line and a character, and an agent starting from a name has neither — so every navigation began with a grep, which is the text path this package exists to replace, reintroduced as a prerequisite. `symbols(query, scope?)` finds a declaration by name with no position at all.

`hover(file, line, character)` gives a symbol's resolved type and documentation without opening the file. Its `contents` may be **empty**, and that is a real answer: hovering over whitespace or a comment resolves to nothing, and a caller has to be able to tell that from a server that broke.

**Capabilities are READ from the initialize result, never probed.** A server with a workspace index answers `workspace/symbol`; one with only document symbols falls back to `textDocument/documentSymbol`; one declaring neither returns `{ kind: 'unsupported' }` naming both missing capabilities. Sending the request and interpreting whatever error comes back works until a server answers an error for a transient reason, and the fallback then fires for a capability the server has. The `documentSymbol` reply is a tree and is walked — a reader that took only the top level would miss every method, which is most of what a name search is for.

**`RoutingCodeNavigationProvider` maps extension to server**, starting one lazily per language on first use and reusing it. A file whose extension maps to nothing gets `{ kind: 'unsupported' }` naming the extension — not a default server, which would send the file to something that cannot read it and answer nothing, which reads as a symbol with no references. A `symbols` call with no scope asks every configured language, and reports `unsupported` rather than an empty list when every server refused, because "nobody looked" is not "the name does not exist".

The `lsp` builtin's input is a discriminated union: position is **required** for `definition`/`references`/`hover` and **absent** for `symbols`. Making it unconditionally optional lets a `definition` with no line silently resolve the top of the file; making it unconditionally required forces a `symbols` call to invent two numbers.
