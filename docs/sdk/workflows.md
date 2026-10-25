---
type: Reference
title: Workflows
description: WorkflowRuntime runs a model-authored orchestration script in the code interpreter, with agent() as its only capability, bounded scheduling, phases, events and a journal.
resource: packages/sdk/src/execution/workflow
tags: [sdk, workflows, orchestration, execution]
status: stable
generated:
  by: claude-sonnet-5-5
  at: 2026-10-18
---

# Workflows

A **workflow** is one background run of a script the model writes once. The
script decides how many subagents run, with which prompts, in which order and
under which phase titles; `WorkflowRuntime` schedules them. This is different
from a subagent, where the model decides each one turn by turn. The decision
and its trust model are in `packages/sdk/src/agents/AGENTS.md`.

The script is untrusted model input, the same as a `bash` command line. It
runs in the interpreter that backs [`run_code`](code-execution.md): a fresh
QuickJS WASM context in a worker thread with no filesystem, network, process,
module loading or timers, JSON-only crossings and memory and CPU limits.
Its one capability is `agent()`, which asks your `spawnAgent` to start a
subagent. What that means (permissions, sandbox, tool sets, accounting,
cancellation) is entirely the host's.

## Running one

```ts
import { WorkflowRuntime } from '@namzu/sdk'

const script = `
export const meta = {
  name: 'audit',
  description: 'Scan two packages, then fix what was found',
  phases: [{ title: 'Scan' }, { title: 'Fix', detail: 'safe fixes only' }],
}
phase('Scan')
const findings = await parallel(args.packages.map((p) => () =>
  agent('Scan ' + p, { label: 'scan:' + p, schema: { type: 'object', required: ['summary'] } })))
phase('Fix')
await pipeline(findings.filter(Boolean), (f) => agent('Fix: ' + f.summary))
return { scanned: findings.length }
`

const runtime = new WorkflowRuntime()
const result = await runtime.run({
  script,
  args: { packages: ['core', 'cli'] },
  limits: { maxConcurrency: 4, tokenBudget: 200_000 },
  signal: new AbortController().signal,
  onEvent: (event) => console.log(event.type),
  spawnAgent: async (request, signal) => {
    // Start a subagent through your own delegation path and honour `signal`.
    void signal
    return { state: 'done', text: `done: ${request.prompt}`, tokens: 0, toolCalls: 0 }
  },
})
console.log(result.status, result.usage.agents)
```

`run()` returns a `WorkflowRunResult`: `runId` (`w` plus eight base-36
characters unless you pass one), `status` (`completed`, `failed` or
`stopped`), the script's return value as `result`, a plain `error`, `usage`
(agents, done, failed, skipped, tokens, tool calls, elapsed), `phases` (see
below), `logsTruncated` and `journalError`. A script that cannot start
(missing or non-literal `meta`, too large, unusable `args`) rejects with
`WorkflowScriptError` before any event or journal record.

`onControl(control)` hands you `control.skipAgent(index)`: a queued agent never
starts, a running one is aborted, and its `agent()` resolves `null`.

## The script language

```text
export const meta = { name, description, whenToUse?, phases?: [{ title, detail?, model? }] }
```

`meta` must be the first statement and a pure literal. `parseWorkflowMeta(source)`
reads it without running the script and throws `WorkflowScriptError`, naming the
line and column, for a variable, call, spread, computed key or `${}`
substitution, so an operator can review it before anything runs.

| Name | Meaning |
| --- | --- |
| `agent(prompt, opts?)` | Start a subagent. Options: `label` (default: the first 60 characters of the prompt, whitespace squeezed), `phase`, `schema` (JSON Schema), `agentType`, `model`, `effort`. Resolves to the text, the schema-validated value, or `null` when the agent failed, was skipped, was refused by a budget, or answered outside the schema. |
| `parallel(thunks)` | Start every thunk now; resolves when all are done (a barrier). It never rejects: a thunk that throws resolves to `null` in its place, and the reason goes through `log()` (`Step 2 stopped: …`, shown in the workflow's detail). Filter with `.filter(Boolean)`. |
| `pipeline(items, ...stages)` | One chain per item, no barrier between stages. A stage gets `(prevResult, originalItem, index)`; the first stage gets the item as `prevResult`; an item whose stage resolves `null` or `undefined` stops there and yields `null`. A stage that throws drops its item to `null` the same way (the reason goes through `log()`) and the other items go on. |
| `phase(title)` | Move the global phase cursor. |
| `log(message)` | A progress line (at most 2000 characters). |
| `args` | The JSON you passed to `run()`. |
| `budget` | `{ total, spent(), remaining() }`. `total` is `limits.tokenBudget` or `null`; `spent()` is the tokens this run's agents have used, refreshed on each `agent()` result; `remaining()` is `max(0, total - spent())`, or `Infinity` with no target. It is a hard ceiling: once `spent()` reaches `total`, `agent()` throws a `WorkflowBudgetExceededError` (agents already running finish), `pipeline()` throws at its start, and inside `parallel()` / `pipeline()` the throw drops the slot to `null` with one summary line. `tokensUsed` and `tokenLimit` remain as deprecated aliases. Guard loops on `budget.total` and give them a hard iteration cap. |

`return` supplies the result. There is no `require`, `process`, `fetch`, timer
or `import()`. This version leaves out nested `workflow()`, worktree isolation, resume from a journal and
saved workflows.

### When a script fails

A script that throws, or does not parse, fails the run. `WorkflowRunResult.error`
(also the `error` of `workflow_finished`) is written for the model that
authored the script, so it can repair it instead of guessing:

```
TypeError: not a function — line 7, column 13: const out = await fn(items)
Before it failed: 3 agents started, 2 finished, 1 failed. A rerun starts the whole script again, so finished agents run again. Last phase: "Fix".
```

- The first line is the error's name and message, then the script line (and
  column) the interpreter reports and that line's text, trimmed to 200
  characters. Line numbers count the author's script, with the `meta` statement
  and the interpreter's own helper code accounted for. When the error comes from
  inside `parallel`, `pipeline` or `agent`, the line is the call in the script,
  not the helper.
- Where the interpreter gives no location (a script that throws a bare string,
  say) the message says `the interpreter gave no line number for this error`
  instead of guessing.
- The second line says how far the run got: agents started, finished and failed,
  and the last `phase()` title. With no agent started it reads
  `No agent had started.`

The helpers reject obviously wrong argument shapes with a plain error naming the
signature, for example `pipeline(items, ...stages): the first argument must be
an array, got a function`. That is a convenience inside the interpreter, not
enforcement; the host still validates every `agent()` request.

Schema validation covers `type`, `enum`, `const`, `properties`, `required`,
`additionalProperties`, `items`, `minItems`/`maxItems`, `minLength`/`maxLength`,
`minimum`/`maximum`, `anyOf`, `oneOf` and `allOf`. Other keywords are ignored
(`pattern` on purpose: the schema is model-authored). The schema is also passed
to `spawnAgent`, so a host with native structured output can enforce more. The
result is `outcome.data` when present, otherwise the text parsed as JSON
(one code fence tolerated).

## What the host supplies: `spawnAgent`

`spawnAgent(request, signal)` receives `index` (1-based, in request order),
`label`, `prompt`, `phaseIndex`/`phaseTitle`, `schema`, `agentType`, `model`,
`effort` and `onProgress({ tokens, toolCalls, lastToolName, lastToolSummary })`,
and resolves `{ state: 'done' | 'error' | 'skipped', text?, data?, tokens,
toolCalls, error? }`. It must honour `signal`, which is aborted when the run is
stopped, fails, or the agent is skipped. A rejected promise counts as an error.
A result larger than `maxValueBytes` is not delivered; the agent is recorded as
failed with that reason.

## Scheduling and limits

`resolveWorkflowLimits(limits?)` returns the limits a run would use, defaults filled in; a host reads it to show an operator the caps before a run starts.

Agents start in the order the script asked, at most `maxConcurrency` at a time
(a first-in, first-out queue). Exceeding a cap fails the run with a plain
reason; running agents are aborted.

| Limit | Default | Range |
| --- | --- | --- |
| `maxConcurrency` | `min(16, cpus - 2)`, at least 2 | 1-16 |
| `maxAgents` | 1000 | 1-1000 |
| `maxSourceBytes` | 256 KiB | up to 4 MiB |
| `memoryLimitBytes` | 64 MiB | 16-256 MiB |
| `maxValueBytes` | 1 MiB | one value crossing the bridge, either way |
| `tokenBudget` | none | the script's `budget.total`; when `spent()` reaches it, `agent()` throws and no new agent is admitted |
| `maxDurationMs` | 6 hours | wall clock for the whole run |
| `cpuSliceMs` / `cpuTotalMs` | 2 s / 60 s | synchronous script time per stretch and in total |

Time a script spends awaiting agents does not count against the CPU limits;
a synchronous busy loop or a loop of awaited microtasks does, and the
interpreter is interrupted. `args` must be plain JSON up to 64 KiB. A
prompt may be up to 200 KiB; `agent()` refuses anything else the host cannot
validate (unknown option, non-string label, schema over 32 KiB). The host
re-validates every call, so a compromised prelude cannot widen the bridge.
`log()` and `phase()` lines share a 256 KiB output budget; later lines are
dropped and `logsTruncated` is set.

## Phases

A phase is a title the script chooses. Titles in `meta.phases` are announced
first, in declared order. `phase(title)` moves the global cursor;
`agent(..., { phase })` assigns explicitly, which avoids races on the cursor
inside `parallel()` or `pipeline()`. The same title (after trimming and
collapsing whitespace) is the same group, and the index is first-seen order
starting at 1. An agent with neither a cursor nor an explicit phase has no
phase index; `result.phases` and `summarizeWorkflowPhases()` list those under a
derived group `Agents` (index 0). A phase is `not-started` until it has an
agent, `running` while any agent is queued or running, then `failed` if any
agent failed and `done` otherwise.

## Events

`onEvent` receives, in order: `workflow_started` (name, description, declared
phases), `workflow_phase` (index, title, `declared`) per new title,
`workflow_agent`, `workflow_log` and finally `workflow_finished`
(`status`, `result` or `error`, `usage`).

`workflow_agent` carries `state` (`start`, `progress`, `done`, `error`),
`index`, `label`, `phaseIndex`, `phaseTitle`, `agentType`, `model`, `queuedAt`,
`startedAt`, `finishedAt`, `lastProgressAt`, `tokens`, `toolCalls`,
`lastToolName`, `lastToolSummary`, `promptPreview`, `resultPreview` and
`error`. An agent emits `start` when queued (no `startedAt`), `start` again
when it begins (with `startedAt`), any number of `progress`, then `done` or
`error`. A skipped agent is `done` with `skipped: true`. A throwing listener is
ignored.

## Journal

Pass `journal` to keep an audit trail. `WorkflowJournal.append(record)` is
called in order with `run_started` (script sha256 and size, `meta`, `args`,
limits), `phase`, `agent_request` (index, label, phase, prompt preview and
sha256, options), `agent_outcome` (state, tokens, tool calls, timings, result
preview, error), `log` and `run_finished`. `writeScript(source, sha256)` is
called first with the exact script. A journal that fails never stops the run;
the first failure is reported as `journalError`.

`FileWorkflowJournal(dir)` writes `script.js` and an append-only
`journal.jsonl` (files mode 0600) under `dir`, normally
`<session>/runs/<runId>/workflow/`.

## Process boundary

The interpreter gets the script, `args` and a small prelude that defines the
globals above and removes the two bridge natives from the global object. The
only message the worker can send that the host acts on is the `agent` call;
`phase()` and `log()` are printed JSON lines, which the host treats as
untrusted text. See [Bounded code execution](code-execution.md) for what the
interpreter withholds and what its tests establish.
