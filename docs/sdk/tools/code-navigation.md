---
uid: namzu.sdk.tools.code-navigation
title: Code navigation — the call site grep cannot find
description: Why an agent asked for call sites needs symbol resolution rather than a regex, what the three-member result union protects against, why the lsp tool is not registered without a provider, and how one server per language is routed by file extension.
type: Guide
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-16T00:00:00Z
lastReviewed: 2026-08-16
resource: packages/sdk/src/tools/builtins/lsp.ts
tags: [sdk, tools, navigation, lsp]
---

# Code navigation

The whole code-navigation surface a namzu agent had was `grep` (regex over
file text) and `glob` (filename patterns). Ask for every call site of
`computeTotal` and you get:

- the comment that mentions it,
- the string literal that names it,
- the unrelated same-named function in another scope,

and you **miss** the call site that arrives through a re-export or a
destructure — which is exactly the one a rename has to get right.

`@namzu/lsp` is the optional package that closes that. The SDK owns the
seam; the package owns the process that answers.

## Turning it on

```ts
import { RoutingCodeNavigationProvider } from '@namzu/lsp'
import { getCodeNavigationTools, ToolRegistry } from '@namzu/sdk'

const codeNavigation = new RoutingCodeNavigationProvider({
  routes: [
    { extensions: ['.ts', '.tsx'], server: { command: 'ts-server', rootDir } },
    { extensions: ['.py'], server: { command: 'py-server', rootDir } },
  ],
})

const registry = new ToolRegistry()
for (const tool of getCodeNavigationTools(codeNavigation)) registry.register(tool)
// …and put `codeNavigation` on the ToolContext, the way a Sandbox arrives.
```

## The tool is absent when there is nothing to call

`getCodeNavigationTools(undefined)` returns `[]`. A tool that is always
present and always answers "unavailable" costs a decision on every turn to
say nothing, and it teaches a model that this capability exists when it does
not.

That is the opposite trade from `job`, which ships unconditionally beside
`bash` because it has a real answer either way. The two look alike from the
outside and the difference is whether an unconfigured run gets information
or noise.

## Four operations, and which one to start with

| | |
|---|---|
| `symbols(query, scope?)` | Find a declaration **by name**, with no position. |
| `definition(file, line, character)` | Where the symbol under the position is declared. |
| `references(file, line, character)` | Everywhere it is used, excluding the declaration. |
| `hover(file, line, character)` | Its resolved type and documentation. |

**Start with `symbols`.** The other three need a line and a character, and
an agent starting from a name has neither — so without it, every navigation
began with a grep, which is the text path this replaces reintroduced as its
own prerequisite.

The `lsp` tool's input is a discriminated union: position is **required**
for the three positional operations and **absent** for `symbols`. Making it
unconditionally optional lets a `definition` with no line silently resolve
the top of the file; making it unconditionally required forces a name search
to invent two numbers.

## Three answers, not two

```ts
type CodeNavigationResult =
  | { kind: 'locations'; locations: readonly SourceLocation[] }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'failed'; error: string }
```

- `unsupported` — this server does not do that. A caller can fall back to
  `grep` and **say** the answer is textual.
- `failed` — something broke, and the answer is unknown.

**Neither is `{ kind: 'locations', locations: [] }`.** An empty list means "I
looked, and there are none" — the answer a deletion depends on. A provider
that answered a missing binary with an empty list would tell an agent a
symbol has no callers, and the agent would delete it. So a server that never
completes `initialize` produces `failed` naming the binary, within a bounded
startup timeout, and the failure is remembered rather than respawning a
process per call.

`hover` carries the same distinction one level down: its `contents` may be
empty, because hovering over whitespace or a comment resolves to nothing,
and that is a real answer.

## Capabilities are read, not probed

A server states what it can do in the `initialize` result. The provider
reads that: a workspace index answers `workspace/symbol`, a server with only
document symbols falls back to `textDocument/documentSymbol`, and one
declaring neither is reported `unsupported` naming both.

Sending the request and interpreting whatever error comes back works until a
server answers an error for a transient reason — and the fallback then fires
for a capability the server actually has.

## One server per language

`RoutingCodeNavigationProvider` maps extension to server, starts one lazily
on first use, and reuses it. A file whose extension maps to nothing is
`unsupported` **naming the extension** — never routed to a default, which
would send the file to a server that cannot read it, which answers nothing,
which reads as a symbol with no references.

A `symbols` call with no scope asks every configured language. When every
server refused, the result is `unsupported` rather than an empty list:
"nobody looked" is not "the name does not exist".

## Containment

Every path goes through `resolveWithinReal` **before** it reaches the
server, the same containment `read` and `grep` use. A language server indexes
a workspace and will happily answer about `../../etc/passwd` if asked; the
boundary is the tool's job, not the server's.

## Disposal

`dispose()` sends the `shutdown`/`exit` handshake before killing, so a
server holding a lock file or mid-write on an index gets to finish, and
falls back to `SIGKILL` on a bounded timeout so one that ignores `exit`
cannot keep the run alive.
