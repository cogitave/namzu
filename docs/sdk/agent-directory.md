---
uid: namzu.sdk.agent-directory
title: The agent directory
description: A convention for laying an agent out as a directory — instructions, tools, skills and delegates — and a loader that turns it into the options the runtime already takes.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-07T00:00:00Z
lastReviewed: 2026-08-07
resource: packages/sdk/src/directory
tags: [sdk, agents, configuration, tools, skills]
verified:
  - by: process:docs-migration
    at: 2026-08-07T00:00:00Z
---

# The agent directory

An agent can be a folder. `loadDirectory` reads a conventional layout —
instructions, tools, skills, delegates — into a manifest, and two `derive`
functions turn that manifest into the options `runAgent` and `SupervisorAgent`
already take.

It is **a loader, not a second engine**. Everything it produces is an ordinary
option, so a caller who outgrows the convention passes overrides, or stops
calling it and keeps everything else. No behaviour is reachable only through
the convention.

## The layout

```
agent/
├─ agent.ts          # optional: default-export a plain config object
├─ instructions.md   # optional: the system prompt, verbatim
├─ tools/            # one tool per file, default-exported
├─ skills/           # one skill per file
└─ agents/           # delegates, each its own directory of the same shape
```

Every part is optional. The five slot names are exported as `ALL_SLOTS`
(`'agent' | 'instructions' | 'tools' | 'skills' | 'agents'`), and
`include` narrows a load to the slots you want.

Only the **top level** of a slot directory is read. A nested directory is
reported as a diagnostic so an author learns their file was not picked up —
except when its name starts with `.` or `_`, which is the conventional way to
say "not for you" and is honoured silently.

## Loading

```ts
import { loadDirectory, deriveRunOptions } from '@namzu/sdk'

const { manifest, diagnostics, ok } = await loadDirectory('./agent')
```

`ok` means **no diagnostic is an error**, and it is scoped to
`manifest.included` — "every slot you asked for is sound", never "this
directory is complete". A caller that scanned only `tools` learns nothing from
`ok` about `instructions`.

Nothing is dropped silently. Every refusal becomes a `DirectoryDiagnostic`
naming its file and reason, and `manifest.sources` lists every file considered
with its outcome, so an inspector can render the whole picture without
re-reading the directory.

### `modules: 'evaluate' | 'skip'` — read this before pointing it at a directory you did not write

Loading is not inert. Under the default `'evaluate'`, the loader **imports every
module-backed file, and importing a module runs it** — a top-level side effect
in `tools/search.ts` executes during `loadDirectory`, in your process, with your
process's privileges.

`'skip'` imports nothing. The manifest still carries the full structural truth —
every path, the instructions, the skills, duplicate and ambiguity detection —
and module-backed entries report the `'not_loaded'` outcome. This is what a CI
gate, a UI file tree, and triage of an unfamiliar directory actually want, and
it is the only mode that is safe against a directory whose author you are not.

Both `derive` functions **throw** on a `'skip'` manifest rather than producing an
agent with no tools and no indication why.

### Outcomes

`SourceRef.outcome` is one of `'loaded'`, `'failed'`, `'skipped'`,
`'not_loaded'`, or `'abandoned'`.

`'abandoned'` is not a synonym for `'failed'`. It means the import outran
`moduleTimeoutMs` (default 10s). **`import()` cannot be cancelled**: the module
is still executing, may still complete, and its top-level side effects may land
after `loadDirectory` has returned. The runtime then caches it, so a second load
in the same process can see the same file succeed instantly. The deadline bounds
*the loader*, not the module.

### Symlinks are refused, not followed

A directory handed to this loader is caller-supplied, and a link inside it
pointing elsewhere means the file that gets imported is not the file that was
listed. Links are refused with a diagnostic. This is deliberately stricter than
the SDK's own skill discovery, which walks a host's own trusted tree.

### A diagnostic's `cause` is not sanitised

`cause` carries text produced by the runtime or thrown by the authored module,
and is exactly as trustworthy as that module. A `throw new Error(secret)` puts
that secret there. The loader never reads file *contents* into a diagnostic, but
it cannot launder what a module chose to throw — treat `cause` as untrusted when
you surface or log it.

## Running one agent

```ts
const options = deriveRunOptions(manifest, { provider, prompt, model })
```

`model` passed here wins over `agent.ts`, and is required when `agent.ts` names
none.

Two behaviours worth knowing:

- **`workingDirectory` is set to the directory itself**, not its parent. Left
  unset it would default to the host's cwd, pointing the file tools' containment
  at the host's source tree rather than at the project. Widening it is your
  explicit call through `overrides`.
- **`name` is forwarded only when `agent.ts` declared one.** `manifest.name`
  falls back to the directory's basename for display, but a name guessed that
  way would become the agent id in traces, where two sibling projects both
  called `agent` would silently merge into one attribution bucket.

## Running a supervisor

```ts
const { config, delegates } = deriveSupervisorOptions(manifest, {
  provider, model, agentManager,
})
```

The host supplies the `AgentManager` and it is never built here: a manager owns
running processes, budgets and cancellation, and handing back options carrying
one this package constructed would make a loader into a runner.

`delegates` come back as **plans, not registrations**. Registering them mutates
your manager, so you do it, in one loop you can see.

A delegate may name its own model and inherits the supervisor's only when it
does not — inheriting unconditionally would bill every narrow specialist at the
coordinator's rate.

`deriveSupervisorOptions` throws when the directory declares no delegates. An
empty roster makes the delegation tool unmountable by design, so the result
would be a coordinator that cannot coordinate, and you asked for a supervisor.

## What this does not do

- **It does not run anything.** It describes; the host runs.
- **A delegate may not declare delegates of its own.** One level only. Deeper
  nesting is a topology decision — who may spawn whom, and how deep — that
  belongs to whoever composes the system, and shipping it before that decision
  means shipping a default nobody chose.
- **There is no `channels/` or `schedules/` slot.** Both were scoped and cut. A
  trigger of `{id, handler}` cannot express a signed webhook, because signature
  verification needs the raw body and a handler receiving a parsed one can never
  check an HMAC; it carries no idempotency key either, while webhooks retry and
  schedules double-fire. Each was a breaking change waiting to happen on a
  published type.
- **The terminal does not read these directories.** This convention is an SDK
  surface. The `namzu` CLI has its own project-instruction discovery, which is a
  separate mechanism with separate rules — do not assume a directory laid out
  this way is picked up by running the CLI in it.
- **`agent.ts` takes a plain object, not a factory.** There is no authoring
  helper: `export default { model: 'x' } satisfies DirectoryConfig` already gets
  the type checking one would provide. A factory would buy environment-
  conditioned config that `process.env` already does inside a module being
  evaluated anyway, at the cost of a hang mode outside what `moduleTimeoutMs`
  bounds.

## Importing what the runtime cannot

`importModule` replaces the import for a project the runtime's own type
stripping cannot read — enums, decorators, path aliases. A host passes its own
importer; three lines, and no bundler dependency in this tree. It is ignored
under `modules: 'skip'`, where nothing is imported at all.
