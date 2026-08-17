<!-- okf
type: Reference
title: "@namzu/lsp"
description: >-
  Language-server-backed code navigation for @namzu/sdk. Drives a real language
  server over stdio to resolve a symbol by name, by declaration, by every use
  and by hover, routing one server per language. Separate from the kernel so a
  consumer who never navigates code spawns nothing.
tags: [readme, package, lsp, code-navigation]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/lsp</h1>

**Symbol resolution for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk), so an agent asked for call sites gets the ones `grep` cannot see.**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)
[![npm](https://img.shields.io/npm/v/@namzu/lsp.svg?label=%40namzu%2Flsp)](https://www.npmjs.com/package/@namzu/lsp)

[Install](#install) · [Wire it up](#wire-it-up) · [Four operations](#four-operations) · [Three answers](#three-answers-not-two) · [One server per language](#one-server-per-language) · [Options](#options)

</div>

---

## What this is

The whole code-navigation surface a namzu agent had was `grep` (regex over
file text) and `glob` (filename patterns). Ask for every call site of
`computeTotal` and you get the comment that mentions it, the string literal
that names it, and the unrelated same-named function in another scope — and
you **miss** the call site that arrives through a re-export or a destructure,
which is exactly the one a rename has to get right.

This package closes that. It drives a real language server over its stdin and
stdout — `Content-Length` framing rather than JSON lines, since a response
carrying source text contains newlines; the `initialize`/`shutdown` handshake;
request correlation — and implements the `CodeNavigationProvider` seam the
kernel declares.

It is separate from the kernel because the kernel owns the shape a tool
programs against and this owns the process that answers. A consumer who never
navigates code carries no extra dependency and spawns no server: the `lsp`
tool is not registered at all in a run that has no provider.

## Install

```bash
pnpm add @namzu/sdk @namzu/lsp
```

`@namzu/sdk` (>=1.0.0) is a peer dependency. This package has no runtime
dependencies of its own — the transport is `node:child_process` and the wire
is JSON — and it does not install a language server for you. You bring the
binary; this drives it.

## Wire it up

```ts
import { RoutingCodeNavigationProvider } from '@namzu/lsp'
import { getCodeNavigationTools, ToolRegistry } from '@namzu/sdk'

const rootDir = process.cwd()

const codeNavigation = new RoutingCodeNavigationProvider({
  routes: [
    { extensions: ['.ts', '.tsx'], server: { command: 'ts-server', args: ['--stdio'], rootDir } },
    { extensions: ['.py'], server: { command: 'py-server', rootDir } },
  ],
})

const registry = new ToolRegistry()
for (const tool of getCodeNavigationTools(codeNavigation)) registry.register(tool)

// …and when the run is over:
await codeNavigation.dispose()
```

`getCodeNavigationTools(undefined)` returns `[]`, so the `lsp` tool is **not
registered at all** in a run that cannot use it. A tool that is always present
and always answers "unavailable" costs a decision on every turn to say
nothing, and it teaches a model that a capability exists when it does not.

Registration is only half the wiring. The tool reads its provider from
`ToolContext.codeNavigation`, and nothing in the run loop fills that field in
for you — `sandbox` reaches a run through the executor, and code navigation
has no equivalent seam. Set `codeNavigation` on the tool context the tool is
executed with. A tool that is registered but reaches a context without a
provider refuses by naming the missing piece rather than answering "no
results", but that refusal is a wiring bug report, not a mode to run in.

For a single-language workspace, skip the router:

```ts
import { StdioCodeNavigationProvider } from '@namzu/lsp'

const codeNavigation = new StdioCodeNavigationProvider({
  command: 'ts-server',
  args: ['--stdio'],
  rootDir: process.cwd(),
})
```

## Four operations

```ts
import type { CodeNavigationProvider } from '@namzu/lsp'

declare const nav: CodeNavigationProvider

const byName = await nav.symbols('computeTotal')                 // no position needed
const declaredAt = await nav.definition('/repo/src/total.ts', 12, 6)
const usedAt = await nav.references('/repo/src/total.ts', 12, 6)
const typeOf = await nav.hover('/repo/src/total.ts', 12, 6)

await nav.dispose()
```

| | |
|---|---|
| `symbols(query, scope?)` | Find a declaration **by name**, with no position. |
| `definition(file, line, character)` | Where the symbol under the position is declared. |
| `references(file, line, character)` | Everywhere it is used, **excluding** the declaration. |
| `hover(file, line, character)` | Its resolved type and documentation. |

**Start with `symbols`.** The other three need a line and a character, and an
agent starting from a name has neither — so without it every navigation begins
with a grep, which is the text path this package exists to replace,
reintroduced as its own prerequisite.

The declaration is left out of `references` deliberately: an agent asking who
calls this wants the call sites, and including the declaration inflates the
count by one and reads as a caller that does not exist.

Positions are zero-based, matching the wire. Paths come back the other way —
`file://` stripped and percent-decoding undone — so a caller gets something it
can hand straight to `readFile`.

## Three answers, not two

```ts
import type { SourceLocation, SymbolLocation } from '@namzu/lsp'

type CodeNavigationResult =
  | { readonly kind: 'locations'; readonly locations: readonly SourceLocation[] }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: string }

type SymbolSearchResult =
  | { readonly kind: 'symbols'; readonly symbols: readonly SymbolLocation[] }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: string }

type HoverResult =
  | { readonly kind: 'hover'; readonly contents: string }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: string }
```

`unsupported` means nothing here can answer that question — the server does
not implement the method, does not declare the capability, or no server is
configured for the file's language. A caller can fall back to `grep` and *say*
the answer is textual. `failed` means something broke, and the answer is
unknown.

**Neither is `{ kind: 'locations', locations: [] }`.** An empty list means "I
looked, and there are none", which is a real answer and the one a deletion
depends on. A provider that answered a missing binary with an empty list would
tell an agent a symbol has no callers, and the agent would delete it. So a
server that never completes `initialize` produces `failed` naming the binary,
inside a bounded startup timeout — and the failure is *remembered*, so a run
that asks twenty times does not spawn twenty servers against a binary that is
not there.

`hover` carries the same distinction one level down: `contents` may be the
empty string, because hovering over whitespace or a comment resolves to
nothing, and that has to read differently from a server that broke.

`SymbolLocation` extends `SourceLocation` with the symbol's `name`, and with
`symbolKind` and `containerName` when the server supplied them.

### Capabilities are read, not probed

What a server can do is taken from the `initialize` **result**, never
discovered by sending a request and interpreting the error. A server with a
workspace index answers `workspace/symbol`; one with only document symbols
falls back to `textDocument/documentSymbol`, which needs a `scope` to look in
and says so when it is missing; one declaring neither is `unsupported`, naming
both. `hover` is refused up front only when the server explicitly declares
`hoverProvider: false`.

Sending the request and swallowing the error works until a server answers an
error for a different reason — a transient one, a malformed query — and the
fallback then fires for a capability the server has. The handshake already
carries the answer.

Two consequences of that split are worth knowing before you read a result.
A server with a workspace index gets the query and decides what matches, so
`scope` chooses which server answers rather than narrowing what it searches;
the `documentSymbol` fallback is the path that filters, and it filters by
plain substring on the symbol name. And the `documentSymbol` reply is a
**tree**, which is walked — a reader that took only the top level would miss
every method, which is most of what somebody searching by name is looking for.

## One server per language

`RoutingCodeNavigationProvider` maps a file extension to a server, starts one
lazily on first use, and reuses it. Starting every configured server up front
pays for languages a run never touches; starting one per request pays the
`initialize` handshake — seconds, for an indexing server — on every call.
`startedCount()` reports how many are running, which is how the reuse is
asserted: a per-request spawn is fast enough on a quick machine to pass a
timing assertion.

A file whose extension maps to nothing is `unsupported` **naming the
extension**. It is not routed to a default, because a default sends the file
to a server that cannot read it, which answers nothing, which reads as a
symbol with no references.

A `symbols` call with **no** scope asks every configured language and
concatenates what they found. If nothing was found anywhere, the reason
matters: a `failed` from any server wins, and when *every* server said
`unsupported` that is what comes back — "nobody looked" is not "the name does
not exist".

Extensions are lower-cased on the way in, so a `.TS` on a case-insensitive
filesystem is not reported as an unconfigured language.

## Options

```ts
import type {
  CodeNavigationRoute,
  RoutingCodeNavigationOptions,
  StdioCodeNavigationOptions,
} from '@namzu/lsp'
```

`StdioCodeNavigationOptions` — one server:

| Option | Default | Notes |
|---|---|---|
| `command` | — | required; the server binary |
| `args` | none | argv for it, e.g. `['--stdio']` |
| `rootDir` | — | required; the child's working directory, and the `rootUri` and workspace folder sent in `initialize` |
| `startupTimeoutMs` | `15_000` | how long `initialize` may take before the provider reports `failed` |
| `requestTimeoutMs` | `20_000` | how long any one request may take |
| `env` | inherited | merged **over** the parent environment; omit it and the child inherits unchanged |

`RoutingCodeNavigationOptions` — one server per language:

| Option | Default | Notes |
|---|---|---|
| `routes` | — | required; each a `CodeNavigationRoute` of `extensions` (with the dot) and one `server` |
| `createProvider` | `new StdioCodeNavigationProvider(…)` | how a route becomes a provider; injectable so a test can count spawns |

## Containment is the tool's job

Every path the `lsp` builtin is given is resolved inside the run's working
directory *before* it reaches the server, through the same containment helper
`read` and `edit` use. A language server indexes a workspace and will happily
answer about `../../etc/passwd` if asked; the boundary belongs to the tool,
not to the process it drives. Calling a provider directly bypasses that, so a host
that does its own dispatch owns the check.

## Disposal

`dispose()` sends the `shutdown`/`exit` handshake **before** killing, so a
server holding a lock file or mid-write on an index gets to finish, and falls
back to `SIGKILL` on a bounded timeout so one that ignores `exit` cannot keep
the run alive. Every in-flight request is rejected rather than left hanging,
and the provider refuses further work instead of quietly respawning.

`RoutingCodeNavigationProvider.dispose()` disposes every server it started.

## Status

`0.x`. The two provider classes and the result unions are what the kernel's
`lsp` builtin programs against, and the surface can still move before 1.0.
`CodeNavigationProvider`, `SourceLocation`, `SymbolLocation` and the three
result unions are re-exported here from `@namzu/sdk` rather than re-declared —
the dependency direction is `sdk ← lsp`, so the kernel owns the shape and this
package implements it, and a second declaration would be a copy that can
drift.

## Further reading

- [`docs/sdk/tools/code-navigation.md`](../../docs/sdk/tools/code-navigation.md)
  — why the result union has three members, why the tool is absent without a
  provider, and how routing decides which server answers.

## License

FSL-1.1-MIT, converting to MIT two years after each release. Same as
`@namzu/sdk`.
