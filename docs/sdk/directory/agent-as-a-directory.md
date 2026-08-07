---
uid: namzu.sdk.directory
title: An agent can be a directory
description: The conventional folder the SDK reads into run options — its five slots, the import-nothing load mode, the diagnostics it returns instead of dropping work, and the two ways a folder-defined agent can be given its system prompt.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-07T00:00:00Z
lastReviewed: 2026-08-07
resource: packages/sdk/src/directory/types.ts
tags: [sdk, directory, agents, convention]
---

# An agent can be a directory

`loadDirectory` reads a conventional folder into exactly the options
`runAgent` already takes. There is no second engine and nothing reachable only
this way: everything the convention produces is an ordinary `RunAgentOptions`
field, so a caller who needs something it does not cover spreads `overrides` or
stops using it.

## The smallest one that works

```
agent/
└── instructions.md
```

```typescript
import { deriveRunOptions, loadDirectory, runAgent } from '@namzu/sdk'

const { manifest } = await loadDirectory('./agent')
const { output } = await runAgent(
  deriveRunOptions(manifest, { provider, model: 'mock-model', prompt: 'Hi' }),
)
```

Nothing is strictly required. An empty folder loads with `ok: true` and a
warning, because a missing `instructions.md` is `instructions_missing` at
`warning` severity — `runAgent` treats instructions as optional, and this loader
does not get to overrule the kernel about what a valid agent is.

## The five slots

```
agent/
├── instructions.md     the system prompt, used verbatim
├── agent.ts            export default { model, temperature, maxIterations,
│                         tokenBudget, timeoutMs, name, metadata } — all optional
├── tools/              one file per tool, each default-exporting defineTool(...)
├── skills/             one folder per skill
└── agents/             one folder per delegate, same shape, one level deep
```

That is the whole list — `ALL_SLOTS` in `directory/types.ts`. Note the shape
difference: `tools/` holds **files**, while `skills/` and `agents/` hold
**directories**.

`agent.ts` exports a plain object, not a factory. There is no `defineAgent`
helper: `export default { model: 'x' } satisfies DirectoryConfig` already gets
the type checking one would provide, and the name would collide with the SDK's
existing export. Read an environment variable inside the module if you need to.

### What is deliberately not here

`channels/` and `schedules/` are absent by decision, not omission. A trigger
definition of `{id, handler}` cannot express a signed webhook — signature
verification needs the **raw** body, and a handler receiving a parsed one can
never check an HMAC. It carries no idempotency key either, while webhooks retry
and schedules double-fire, and a cron field with no timezone story is a
declaration nothing drives. Each is a `major` waiting to happen on a published
type.

## Loading a folder does not have to run it

Importing a module executes it. A top-level side effect in `tools/search.ts`
happens during the load, in your process, with your privileges. So the loader
has a mode:

```typescript
const { manifest, diagnostics, ok } = await loadDirectory('./agent', {
  modules: 'skip',
})
```

`modules: 'skip'` imports **nothing** and still returns the full structure:
every path, the instructions, the skills, duplicate detection, and each file
marked `not_loaded`. That is the mode for a CI check, a file tree, or triage of
a directory whose author is not you.

Symlinks inside a slot are refused rather than followed
(`symlink_refused`), for the same reason — the file that gets imported would not
be the file that was listed.

A manifest loaded this way cannot be derived into run options.
`deriveRunOptions` throws rather than producing an agent with no capabilities
and no indication why.

## Nothing is silently dropped

Every refusal comes back as a diagnostic naming its file and reason, at
`error` or `warning` severity. The codes are a closed set, including
`no_default_export`, `not_a_tool`, `duplicate_tool_name` (neither of the
colliding tools is registered), `invalid_config`, `module_load_failed`,
`module_load_abandoned`, `path_escapes_root`, `unscanned_directory` and
`subagent_too_deep`.

`ok` is true when no diagnostic is an error — and it is **scoped to
`manifest.included`**. It means "every slot you asked for is sound", never "this
directory is complete". A caller that scanned only `tools` learns nothing from
`ok` about `instructions`.

## Two ways to give an agent its prompt

A folder's `instructions.md` is used **verbatim** as the system prompt.
`deriveRunOptions` passes it to `runAgent` as `instructions`, which the kernel
maps to `systemPrompt`.

The SDK also ships a structured alternative, the persona assembler
([prompting](../prompting/README.md)). The two are not rival subsystems — they
fill **one slot**, and the prompt builder gives `systemPrompt` precedence over
`persona`. `assembleSystemPrompt(persona)` returns a **string**, so anything it
produces can be the contents of `instructions.md`.

What each choice actually costs:

| | `instructions.md` | `persona` |
|---|---|---|
| Reachable from a folder | yes | not directly — `RunAgentOptions` has no `persona` field |
| Reachable from `runAgent` | yes | no |
| Reachable from `SupervisorAgent` | yes (its `systemPrompt` is required) | no such field |
| Skills rendered into the prompt | yes | yes |
| `sessionContext` split into the cacheable dynamic segment | no | yes |

The row worth reading twice is **skills**: a folder-defined agent does *not*
lose them. The prompt builder renders the skills section whether the prompt came
from a string or from a persona, and `deriveRunOptions` forwards
`manifest.skills`. The two paths differ in how you *author* the text, not in
what the model ends up seeing beside it.

To get persona structure into a folder, call the assembler yourself and put its
output where the folder expects prose:

```typescript
import { assembleSystemPrompt } from '@namzu/sdk'

// Write the result to agent/instructions.md, or pass it through overrides.
const instructions = assembleSystemPrompt(persona)
```

## Delegates

A folder under `agents/` is a delegate with the same shape. Use
`deriveSupervisorOptions` instead of `deriveRunOptions` for that case; it throws
if the project declares no delegates, since there is nothing to coordinate.

A delegate may name its own model — a cheap one for a narrow job is the common
case — and inherits the supervisor's only when it does not. Inheriting
unconditionally would bill every specialist at the coordinator's rate.

Delegates go **one level**. A delegate may not declare delegates of its own
(`subagent_too_deep`).

## What the folder form does not do

- **It is SDK-only.** The terminal agent does not read an `agent/` folder —
  `loadDirectory` has no call site outside this package. The CLI has its own
  project instructions and trust gate, and the two are unrelated.
- **Nothing auto-discovers.** You pass the path.
- **Config is static.** `agent.ts` exports a plain object; there is no factory
  form and no hook.
- **A name is not guessed.** `manifest.name` falls back to the directory
  basename for display, but `deriveRunOptions` forwards a name to `runAgent`
  only when `agent.ts` declared one — two sibling projects both called `agent`
  would otherwise merge into one attribution bucket in traces.
- **The working directory is the folder itself**, not its parent. Narrower is
  the safe direction; widening it is the caller's explicit call through
  `overrides`.
- **A model is required.** Declare it in `agent.ts` or pass it to
  `deriveRunOptions`; there is no default, because anything guessed would be
  billed to the caller.
