# @namzu/project

Turn a conventional agent directory into typed, inspectable definitions.

A **loader, not a runner.** It reads a directory and hands back what is there;
running it is `@namzu/sdk`'s job. That split is what lets this package exist
without bringing a hosting model with it.

```
my-agent/agent/
├── agent.ts          # optional — model, temperature, budgets
├── instructions.md   # optional — the system prompt
├── tools/
│   └── search.ts     # default-exports defineTool(…)
└── skills/
    └── plan-a-trip/
        └── SKILL.md
```

```ts
import { loadProject, deriveRunOptions } from '@namzu/project'
import { runAgent } from '@namzu/sdk'

const { manifest, ok, diagnostics } = await loadProject('./agent')
if (!ok) console.error(diagnostics)

const { output } = await runAgent(
  deriveRunOptions(manifest, { provider, prompt: 'What is the weather?' }),
)
```

`deriveRunOptions` produces ordinary `RunAgentOptions`. There is no second code
path — a caller who outgrows the convention passes `overrides`, or stops using
this package and keeps everything else.

## Importing a directory runs it

`loadProject` imports every module-backed file, and **importing a module
executes it**, in this process, with this process's privileges. A top-level
side effect in `tools/search.ts` happens during the load. This is not a
sandbox and there is no in-process boundary that would make it one —
`@namzu/sandbox` confines *tool execution*, not module import.

For a directory whose author you are not, use `modules: 'skip'`:

```ts
const { manifest } = await loadProject('./agent', { modules: 'skip' })
```

Nothing is imported. The manifest still carries the full structural truth —
every path, the instructions, the skills, duplicate and ambiguity detection —
and module-backed entries report `outcome: 'not_loaded'`. This is the mode a
CI gate, a UI file tree, and untrusted-project triage all want.

## TypeScript, without a build step

Files are imported with `await import()`, so `.ts` is handled by Node's own
type stripping. Stripping **erases types, it does not transform code**, and no
flag changes that:

| Not supported | Write instead |
|---|---|
| `enum` | a `const` object with an `as const` union |
| decorators | a wrapper function |
| parameter properties | explicit field assignment |
| runtime `namespace` | a module file |
| `import x = require()` | ESM syntax |
| `./util` (extensionless) | `./util.ts` — the real extension |
| tsconfig `paths` aliases | a relative path, or `importModule` |

Node also refuses to strip types from any `.ts` resolved under `node_modules/`.
If a tool imports a workspace package, that package should ship built `.js`.

When you need any of it, pass your own importer — three lines in your host, no
bundler in this dependency tree:

```ts
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url)

await loadProject('./agent', { importModule: (url) => jiti.import(url) })
```

## Nothing fails silently

A file that cannot be loaded is reported, never dropped. `ok` is
`diagnostics.every(d => d.severity !== 'error')`, scoped to the slots you
scanned — it means "every slot you asked for is sound", not "this directory is
complete".

Two behaviours worth knowing:

- **A symlink is refused, not followed.** The file that would be imported is
  not the file that was listed, and this directory is caller-supplied.
- **A timed-out import is `'abandoned'`, not `'failed'`.** `import()` cannot be
  cancelled: the module is still running, may still finish, and Node caches the
  result — so a later load in the same process can see the same file succeed.
  `moduleTimeoutMs` bounds this loader, not your module.

## What is not here

`channels/` and `schedules/` are not in this version. A trigger of
`{ id, handler }` cannot express a signed webhook — signature verification
needs the raw body, and a handler receiving a parsed one can never check an
HMAC — carries no idempotency key while webhooks retry and schedules
double-fire, and a cron field with no timezone story is a declaration nothing
drives. Each would be a breaking change to a published type. The shape question
gets its own pass.

`instructions.md` is **not** wrapped as untrusted content: it is the project's
own system prompt, and framing it as material-to-consider makes it not one. A
host that does not trust the directory wraps `manifest.instructions` with
`wrapUntrusted` from `@namzu/sdk` before passing it on.
