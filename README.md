<!-- okf
type: Index
title: Namzu
description: >-
  An open-source agent platform for TypeScript. Ships an operator application,
  a reusable kernel and optional runtimes for supervised agents with explicit
  identity, budgets, permissions and pluggable durability. FSL-1.1-MIT,
  converting to MIT two years after each release.
tags: [readme, index, typescript, agent-platform]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-07T00:00:00Z }
-->

<div align="center">

<h1>Namzu</h1>

**An open-source agent platform for TypeScript.**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](./LICENSE.md)
[![npm @namzu/sdk](https://img.shields.io/npm/v/@namzu/sdk.svg?label=%40namzu%2Fsdk)](https://www.npmjs.com/package/@namzu/sdk)
[![npm @namzu/cli](https://img.shields.io/npm/v/@namzu/cli.svg?label=%40namzu%2Fcli)](https://www.npmjs.com/package/@namzu/cli)

[Install](#install) · [An agent is a folder](#or-dont-write-any-of-that--make-a-folder) · [What is inside](#what-is-inside-that-is-independently-hard) · [Packages](#the-packages) · [Docs](./docs/)

</div>

---

## What this is

An agent that works in a demo is a loop around a model call. An agent that
works in production is that loop plus everything around it — a budget that
stops it, an identity that attributes it, a boundary it cannot talk its way
past, a record that can survive the process when durable stores are configured,
and a way to shrink a conversation that is about to overflow without corrupting
it.

Namzu is the platform for those other things. Its `@namzu/sdk` kernel runs an
agent the way an operating system runs a process: it is given an identity and a
budget, scheduled, checkpointed, and optionally confined by the sandbox a host
supplies. The kernel renders no UI, requires no database, hosts no service, and
has no preferred model vendor. Direct SDK consumers install only the driver
packages they use; the CLI bundles its supported set.

`@namzu/cli` is a terminal coding agent built entirely on that kernel, in this
repository, from the same public API you get. It exists as much to prove the
kernel as to be used: every gap in the SDK showed up first as something the
CLI had to work around.

## Who it is for

Read on if any of these is your afternoon:

- The run has to be **attributable** — a tenant, a project, a session, and an
  auditable trail of what it did and what it cost.
- The run has to be **bounded** — tokens, money, wall clock, and iterations,
  enforced rather than hoped for.
- The run has to **survive** — a process restart, a deploy, an operator
  pressing Ctrl-C, a question that needs a human before it can continue.
- One agent has to **delegate** to another, and that is where it broke.
- The model gets **tools**, and you would rather it not get your machine.
- You are **multi-tenant**, and "two customers in one process" has to be a
  property of the type system rather than a code review.

Read something else if you want a chat interface by the end of the day. There
is no UI here, no dashboard, no hosted anything. This is the layer underneath
that.

## Install

The kernel runs standalone against a scriptable mock driver, so the first run
needs no key and no network:

```bash
pnpm add @namzu/sdk zod@^3
```

<sub>The kernel bundles no runtime dependencies — `zod`, `zod-to-json-schema`
and `@opentelemetry/api` are peer-declared so your lockfile owns the versions.
Pin `zod` to v3: that is the range the kernel is built against, and a bare
`pnpm add zod` installs v4.</sub>

```typescript
import { ProviderRegistry, runAgent } from '@namzu/sdk'

const { provider } = ProviderRegistry.create({ type: 'mock', responseText: 'Paris.' })

const { output, run, identity } = await runAgent({
  provider,
  model: 'mock-model',
  prompt: 'What is the capital of France?',
})

console.log(output)          // 'Paris.'
console.log(run.stopReason)  // 'end_turn'
console.log(identity)        // { sessionId, threadId, projectId, tenantId }
```

That is not a chat call with extra steps. It generated a session identity,
applied the default budgets, ran the tool scheduler, wrote a checkpoint per
iteration, and left the whole run on disk under
`.namzu/projects/<project>/sessions/<session>/runs/<run>/` — `run.json`,
`messages.json`, `transcript.jsonl`, a human-readable `report.md`, and a
`checkpoints/` directory.

`identity` comes back so the next turn continues the same session:

```typescript
import { createUserMessage } from '@namzu/sdk'

const second = await runAgent({
  provider,
  model: 'mock-model',
  ...identity,
  prompt: [...run.messages, createUserMessage('And of Japan?')],
})
```

Give it tools and the same call runs a tool loop:

```typescript
import { defineTool, ToolRegistry } from '@namzu/sdk'
import { z } from 'zod'

const tools = new ToolRegistry()

tools.register(
  defineTool({
    name: 'get_weather',
    description: 'Current weather for a city.',
    inputSchema: z.object({ city: z.string() }),
    category: 'network',
    permissions: ['network_access'],
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    execute: async ({ city }) => ({
      success: true,
      output: `It is 17C and raining in ${city}.`,
    }),
  }),
)

const { output } = await runAgent({
  provider,
  model: 'mock-model',
  tools,
  prompt: 'What is the weather in Paris?',
})
```

A tool declares what it *is* — read-only or not, destructive or not, safe to
run concurrently or not, and which permissions it needs — because the
scheduler, the permission gate and the operator prompt all have to ask those
questions, and a tool that will not answer them forces every one of them to
assume the worst.

To talk to a real service, install a driver and swap the two lines that
construct the provider. Nothing below them changes.

```bash
pnpm add @namzu/sdk @namzu/ollama    # local, no key
```

### Or don't write any of that — make a folder

An agent can be a directory. `loadDirectory` reads a conventional folder into
exactly the options `runAgent` already takes, so there is no second engine and
nothing reachable only this way.

The smallest one that works is a folder with a file in it:

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

Everything else is optional, and each slot buys one thing:

```
agent/
├── instructions.md     the system prompt, used verbatim
├── agent.ts            export default { model, temperature, maxIterations,
│                         tokenBudget, timeoutMs, name, metadata } — all optional
├── tools/              one file per tool, each default-exporting defineTool(...)
├── skills/             one folder per skill
└── agents/             one folder per delegate, same shape, one level deep
```

`instructions.md` is used verbatim, and it is one of **two** ways to shape an
agent here. The other is the structured persona assembler, and the two are not
rival subsystems — they fill one slot, with a plain system prompt taking
precedence over a persona. `assembleSystemPrompt(persona)` returns a string, so
its output can simply be what `instructions.md` contains. A folder does not lose
its skills by taking the simple route: the skills section is rendered either way.
The trade-off is set out in
[an agent can be a directory](docs/sdk/directory/agent-as-a-directory.md).

A tool file is a normal module:

```typescript
// agent/tools/weather.ts
import { defineTool } from '@namzu/sdk'
import { z } from 'zod'

export default defineTool({
  name: 'get_weather',
  description: 'Current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  category: 'network',
  permissions: ['network_access'],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  execute: async ({ city }) => ({ success: true, output: `It is 17C in ${city}.` }),
})
```

That is the whole convention. A recent runtime imports the `.ts` directly, so
there is no build step; a project whose syntax it cannot read passes its own
`importModule`.

**Loading a folder does not have to run it.** Importing a module executes it —
a top-level side effect in `tools/search.ts` happens during the load, in your
process, with your privileges. So the loader has a mode:
`loadDirectory(dir, { modules: 'skip' })` imports **nothing**, and still returns
the full structure: every path, the instructions, the skills, duplicate
detection, and each file marked `not_loaded`. That is the mode for a CI check,
a file tree, or triage of a directory whose author is not you. Symlinks inside
a slot are refused rather than followed, for the same reason — the file that
gets imported would not be the file that was listed.

Nothing is silently dropped. Every refusal comes back as a diagnostic naming
its file and reason: a tool file with no default export, two tools claiming one
name (neither is registered), an empty `instructions.md`, a nested directory
that was not scanned. `ok` tells you whether any of them was an error — scoped
to the slots you asked for, so it never means more than it checked.

**What the folder form does not do**, so you find out here rather than later:

- **It is SDK-only today.** The terminal agent does not read an `agent/`
  folder — it has its own project instructions and trust gate, and the two are
  unrelated. Nothing auto-discovers: you pass the path.
- **Config is static.** `agent.ts` exports a plain object, not a factory. Read
  an environment variable inside it if you need to; there is no hook.
- **Delegates go one level.** A delegate may not declare delegates of its own.
- **A skipped load cannot be run.** `deriveRunOptions` throws on a
  `modules: 'skip'` manifest rather than handing back an agent whose tools are
  all missing for a reason unrelated to the project.
- **The working directory becomes the folder itself**, not its parent, so file
  tools are contained to the agent. Widening that is an explicit override.

### The terminal agent

```bash
# Install it
curl -fsSL https://raw.githubusercontent.com/cogitave/namzu/main/install.sh | sh

# Windows
irm https://raw.githubusercontent.com/cogitave/namzu/main/install.ps1 | iex

# Or, if you would rather not pipe a script into a shell
npm install -g @namzu/cli

# Or run it once without installing
npx @namzu/cli
```

The installer checks for Node 20+, installs the package, and then verifies the
binary answers before claiming success. If your global prefix is not writable
it retries into `~/.namzu` and tells you the one line to add to your profile —
it never re-runs itself with elevated privileges.

Bare `namzu` opens an interactive terminal agent. The same binary is
scriptable: `namzu run` for a single headless prompt, `namzu run-stream` for
newline-delimited events a host UI can consume, `namzu history`,
`namzu doctor`, `namzu upgrade`, `namzu skills`, and `namzu eval`, plus `namzu providers-json`
and `namzu skills-json` for a host UI that wants the rosters as JSON. Run
`namzu --help` for the current list.

The TUI names `namzu upgrade` when npm reports a newer version. The command
updates the npm-global prefix that owns the running package and verifies that
exact package before claiming success; `namzu upgrade --check` is read-only.

Three things it does on the way in are worth knowing, because they are the
difference between a toy and something you point at a real repository:

- **A folder nobody has trusted is not one it runs in.** On launch in an
  unfamiliar working directory it stops and asks, because reading, running
  commands and editing files there is what it is about to be able to do.
- **The repository gets to state how it wants work done.** An `AGENTS.md` is
  read from the working directory upward to the repository root, outermost
  first, so the file nearest the work has the final word. Before this existed
  everything the agent was told was about the *user* and global to the
  machine; a project that had written its conventions down had no way to be
  heard short of pasting the file in every session.
- **It connects to the tool servers you declare**, so the tools available in a
  given checkout are that checkout's business rather than the binary's.

## What is inside that is independently hard

The reason this repository is larger than a loop is that each of the following
is a problem you hit at a specific hour of building an agent product, and each
one is a thing you would otherwise stop and solve yourself. Every item names
the file that implements it, because a README is a claim and the code is the
evidence.

**Shrinking a conversation without corrupting it.**
The window fills and something has to go, but you cannot simply drop the
oldest messages. An assistant turn that asked for a tool and the result that
answers it are a matched pair, and a provider rejects a conversation
containing one without the other — so the naive trim turns a context problem
into a hard API error. `findDanglingMessages` scans for both halves of that
break, and `findSafeTrimIndex` picks a cut that does not create one. The
window size itself is resolved by longest-prefix match on the model id, with
a deliberately conservative default for an unrecognised model: compacting too
early costs one summarisation pass, and compacting too late ends the run with
nothing recoverable.
→ `packages/sdk/src/compaction/dangling.ts`, `compaction/context-window.ts`

**A run that outlives the process that started it.**
Each iteration writes a checkpoint carrying the history, the budgets, the
working state and the trace context. `resumeRun` joins one of those snapshots
back onto a live loop in a *different* process. It returns three outcomes
rather than a nullable run, because the two failures mean opposite things: "no
checkpoint" is a dead end, while "parked awaiting a decision" is the run
working exactly as designed and waiting for a human. On `SIGINT` or `SIGTERM`
an opt-in emergency save writes the run out before the process leaves.
→ `runtime/query/resume-run.ts`, `runtime/query/checkpoint.ts`, `manager/run/emergency.ts`

**Delegation that cannot quietly corrupt itself.**
Work is a five-layer hierarchy — project, thread, session, sub-session, run —
and each layer's id is its own type carrying its own prefix, so handing a
session id to something expecting a run id does not compile. Depth and width
caps are checked *before* any write, and the width check plus the write that
invalidates it are held in one critical section keyed on the parent: without
that, two concurrent spawns both read the same count, both saw room, and a cap
of N admitted N+1. Session ownership is a compare-and-set against the version
the *store* holds — previously two concurrent handoffs could both pass, both
provision a workspace, and one silently erase the other. Archiving a project
refuses rather than cascades while live sessions are attached, because closing
a workspace under a running agent abandons work whose owner is still watching.
And a delegated task whose launching call already timed out still produced a
result somebody should see; the completion inbox is what stops it being
dropped on the floor.
→ `session/handoff/capacity.ts`, `manager/agent/lifecycle.ts`, `session/errors.ts`, `gateway/completion-inbox.ts`

**A budget that survives being divided.**
Five dimensions are checked every iteration — cancellation, wall clock, token
budget, cost, and iteration count — each producing a named stop reason rather
than an exception, with a warning tier before the hard stop so a run can react
while it still can. Dividing that budget across a delegation tree is where it
gets interesting.
A child gets a slice of its parent's remaining tokens, computed inside the
spawn lock so siblings queue instead of all reading the same untouched number,
debited only once provisioning commits so a rejected spawn costs nothing, and
*refunded* on settle. The refund is the part that is easy to miss and
expensive to omit: without it the pool shrinks by the full allocation
regardless of what the child spent, and ten delegations leave a parent with a
thousandth of its budget. A spawn whose allocation rounds to zero is refused
outright rather than granted, because zero means *unlimited* downstream — so
the naive arithmetic hands the most depleted parent in the tree an unbounded
child.
→ `manager/agent/lifecycle.ts`, `run/LimitChecker.ts`

**A refusal the model can actually act on.**
A permission gate that answers only "denied" produces thrashing: the model
rewords the same call and tries again, because nothing told it that retrying
is pointless. Every rule here can describe itself in a sentence — which rule
matched, which argument, whether a different input could ever get through — and
that sentence goes back to the model inside the tool result. Approvals are
scoped by the approver rather than fixed: a grant can cover one exact
invocation or an entire tool, and the key is built from arguments serialised
with sorted properties, so the same call never gets asked about twice merely
because two fields swapped order. Grants live for the run and are never
persisted.
→ `verification/gate.ts`, `runtime/query/tool-grants.ts`

**Content the agent must read but must not obey.**
Anything a tool returns — a fetched page, another agent's output, a connector's
prompt — is wrapped in an envelope that says whose words these are and that
they are material rather than instruction. Two details separate a boundary
from a decoration, and both were missing the first time: the closing token is
neutralised inside the body, so content carrying the delimiter cannot end the
block early and have the rest read as unlabelled instructions; and there is no
"already wrapped" fast path, because that check is forgeable by text that
merely starts with the opening tag.
→ `tools/untrusted-envelope.ts`

**Isolation that tells you what it is not enforcing.**
Sandbox tiers do not all provide the same controls, and the honest table is
kept in code: one environment enforces filesystem, network and process
isolation; another enforces network and process only and reports
`filesystem: false` **on purpose**, because it unshares a mount namespace
without remounting anything and a private mount table is not confinement. If a
run requires a control the host cannot supply, the kernel refuses to start it
rather than proceeding while the caller believes it is confined. A security
control that is accepted and silently not applied is worse than one that was
never offered.
→ `sandbox/isolation.ts`

**Provider differences that are really latent bugs.**
Several services spell a model id the same way, ending in either a minor
version or an eight-digit release date. Three drivers had each written the
same matcher and all three read the date as the minor, so an id naming no
minor compared as enormously *newer* — and every capability check keyed on
that comparison inverted, telling a model it supported features it does not.
There is now one parser, given the vocabulary by the driver that knows it.
Alongside it: strict tool schemas are a *subset* of JSON Schema, and a single
keyword outside that subset makes a service reject the whole request rather
than degrade one field, so violations are found before the call; one tool
schema is rendered once and converted per dialect at the driver; and a driver
that cannot honour a requested capability must refuse rather than drop it.
→ `provider/model-version.ts`, `provider/strict-schema.ts`, `registry/tool/dialect.ts`, `provider/thinking-support.ts`

**Correcting a run that is already going.**
Watching an agent head the wrong way, the two obvious options are both bad:
cancelling discards every tool result already paid for, and rejecting through
the review gate only works if a call happens to be pending and can only say
"no" when you meant "yes, but look at this first". There is also no legal
place to insert a user message mid-batch — a tool call must be answered by its
matching result. So guidance rides on the tool result itself, the slot the
model already reads for outcomes. It does not interrupt; the batch in flight
finishes and the note lands where the model looks next.
→ `runtime/query/steering.ts`

**Reading an agent directory you did not write.**
A conventional `agent/` folder can contribute instructions, tools, skills and
sub-agents. Loading one has a mode, because importing a module *runs* it — a
top-level side effect executes in your process with your privileges. `'skip'`
imports nothing and still returns the full structural truth: every path, the
instructions, the skills, and duplicate detection. That is what a CI check, a
file tree, and triage of somebody else's directory all actually want.
→ `directory/types.ts`, `directory/load.ts`

## The packages

`@namzu/sdk` is the kernel and has no workspace dependencies. Runtime extension
packages depend on it through `peerDependencies`; the CLI is the composition
root and owns direct dependencies on the extensions it ships. `@namzu/files`
is standalone. Nothing in the kernel depends back on any leaf package.

| Package | What it is |
|---|---|
| `@namzu/sdk` | The kernel: run loop, tools, sessions, budgets, compaction, checkpoints, permission gate, connectors, telemetry |
| `@namzu/cli` | The terminal agent, and the operator commands. Also importable as a library |
| `@namzu/sandbox` | Sandbox providers beyond the in-kernel one |
| `@namzu/telemetry` | The exporter pipeline, kept separate so consumers who emit nothing install nothing |
| `@namzu/computer-use` | Screenshot, mouse and keyboard control through platform-native tools |
| `@namzu/live` | Transport-agnostic live sessions orchestrating caller-supplied speech and audio-output drivers |
| `@namzu/lsp` | Language-server-backed code navigation and symbol resolution |
| `@namzu/files` | File registry contracts, with in-memory, local-disk, Azure Blob and HTTP backends. Pre-1.0 |
| `@namzu/evals` | The kernel's own behaviour suites, runnable against an installed kernel |

Model drivers, one per service. Direct SDK consumers install only what they
use; the CLI bundles the selected drivers named in its package README:

| Package | Notes |
|---|---|
| `@namzu/anthropic` | Streaming, tool use, extended thinking |
| `@namzu/openai` | Chat Completions, streaming, tool use |
| `@namzu/deepseek` | Chat Completions, streaming, tool use, thinking mode |
| `@namzu/bedrock` | Converse API, streaming, tool use |
| `@namzu/openrouter` | Aggregated model access |
| `@namzu/ollama` | Local models |
| `@namzu/lmstudio` | Local models, GUI-managed |
| `@namzu/http` | Zero-dependency driver for any compatible HTTP endpoint |

Every driver implements the same `LLMProvider` contract and registers itself
through `ProviderRegistry`, extending the config union by module augmentation
so `ProviderRegistry.create({ type: 'ollama', ... })` is fully type-narrowed.
A mock driver ships in the kernel, pre-registered, and is scriptable turn by
turn — including malformed and truncated tool calls — so you can test the loop
without the network.

## How this repository is kept honest

Two design rules run through the code, and you will meet both within an hour
of reading it:

- **Refuse, do not silently degrade.** A capability that is accepted and then
  quietly not applied is worse than one that errors, because the caller stops
  looking. A host that cannot supply a requested isolation control gets a
  refusal, not a weaker sandbox; a driver that cannot honour a requested
  capability must say so rather than drop the field.
- **A declaration nothing drives is a defect.** A field no code reads and a
  check that cannot fail are treated as bugs rather than as roadmap. Where a
  thing genuinely is not built yet, the honest state is written down next to
  it rather than implied away.

Alongside those, the pull-request gate runs more than the usual four. Besides
lint, typecheck, build and tests on two Node versions, every change also has
to pass: a **public-surface baseline diff** (a symbol cannot vanish from the
package barrel unnoticed); **per-module coverage floors** plus a rule that
every source folder is explicitly classified for test presence; a
**behaviour-regression eval suite**; **process-level tests** run in a real
separate process, because an in-process test cannot prove a run survives on
its own event-loop footprint; a **consumer-install check** that catches
peer-range drift before a publish rather than at the registry; package-manifest
validation; and an audit that refuses a list of third-party product names in
prose and identifiers, exempting the paths and the published vocabulary whose
job is to speak somebody else's protocol — a driver package has to name the
service it drives, and a page telling an operator what namzu connects to has
to name it too.

## Next

- [`docs/`](./docs/) — the longer-form documentation: the
  [conventions](./docs/conventions/) this repository is written to, and
  reference pages for the [SDK](./docs/sdk/), [CLI](./docs/cli/),
  [extension packages](./docs/packages/) and [providers](./docs/providers/).
  Read it here in the repository: there is no documentation site yet.
- [`packages/sdk/README.md`](./packages/sdk/README.md) — the kernel's
  subsystem map.
- `AGENTS.md` — the working contract any coding agent in this repository
  follows.

Some pages under `docs/` predate recent kernel changes, and an audit of them is
partly done rather than finished. Where a page and the code disagree, the code
is correct; please open an issue.

## Status

Releases are driven by Changesets, so a package newly added on `main` can
appear in this table before its first registry release. Two things a reader
should weigh honestly:

- **Majors move quickly.** This project treats *any* backward-incompatible
  change to a public API as a major, however small the diff — so the version
  number tracks the surface rather than the size of the work, and it climbs
  faster than you may expect. Pin your dependency and read the changelog.
- **`@namzu/cli`, `@namzu/files`, `@namzu/evals`, `@namzu/live` and
  `@namzu/lsp` are pre-1.0** and their APIs still move. The kernel itself is
  the stable surface.

Node 20 or newer is declared; CI exercises 22 and 24.

## Contributing

Issues and pull requests welcome at
[cogitave/namzu](https://github.com/cogitave/namzu). See
[`packages/sdk/CONTRIBUTING.md`](./packages/sdk/CONTRIBUTING.md).

## License

[FSL-1.1-MIT](./LICENSE.md) — every published version becomes MIT-licensed two
years after its release.
