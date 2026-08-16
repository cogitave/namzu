# @namzu/lsp

Language-server-backed code navigation for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk). An agent asked for the call sites of a function gets symbol resolution rather than regex matches.

## Why

The whole code-navigation surface a namzu agent had was `grep` (regex over file text) and `glob` (filename patterns). Ask for every call site of `computeTotal` and you get:

- the comment that mentions it,
- the string literal that names it,
- the unrelated same-named function in another scope,

and you **miss** the call site that arrives through a re-export or a destructure — which is exactly the one a rename has to get right.

## Install

```bash
pnpm add @namzu/sdk @namzu/lsp
```

## Usage

```ts
import { StdioCodeNavigationProvider } from '@namzu/lsp'
import { getCodeNavigationTools, ToolRegistry } from '@namzu/sdk'

const codeNavigation = new StdioCodeNavigationProvider({
  command: 'your-language-server',
  args: ['--stdio'],
  rootDir: process.cwd(),
})

const registry = new ToolRegistry()
for (const tool of getCodeNavigationTools(codeNavigation)) registry.register(tool)

// …and put it on the tool context, the same way a Sandbox arrives:
//   { workingDirectory, codeNavigation }

await codeNavigation.dispose()
```

`getCodeNavigationTools` returns an empty array when there is no provider, so the `lsp` tool is **not registered at all** in a run that cannot use it. A tool that is always present and always answers "unavailable" costs a decision on every turn to say nothing.

## Two operations

| | |
|---|---|
| `definition(file, line, character)` | Where the symbol under the position is declared. |
| `references(file, line, character)` | Everywhere it is used, excluding the declaration. |

Positions are zero-based, matching the wire.

## Three answers, not two

```ts
type CodeNavigationResult =
  | { kind: 'locations'; locations: readonly SourceLocation[] }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'failed'; error: string }
```

`unsupported` means the server does not implement that operation — a caller can fall back to `grep` and say the answer is textual. `failed` means something broke, and the answer is unknown.

**Neither is `{ kind: 'locations', locations: [] }`.** An empty list means "I looked, and there are none", which is a real answer and the one a deletion depends on. A provider that answered a missing binary with an empty list would tell an agent a symbol has no callers, and the agent would delete it. So a server that never completes `initialize` produces `failed`, naming the binary, within a bounded startup timeout.

## Disposal

`dispose()` sends the `shutdown`/`exit` handshake before killing, so a server holding a lock file or mid-write on an index gets to finish, and falls back to `SIGKILL` on a bounded timeout so a server that ignores `exit` cannot keep the run alive.
