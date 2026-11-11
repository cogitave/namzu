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
| `parallel(thunks)` | Start every thunk now; resolves when all are done (a barrier). It does not reject for a thunk's own failure: a thunk that throws, or whose agent failed, resolves to `null` in its place, and the reason goes through `log()`. A misused hook is different and fails the run: an `agent()` call with a bad prompt, a non-object `schema` or an oversized request, a non-function item, or a bad `phase()` title is re-thrown out of `parallel()` and `pipeline()` (the run ends `failed` with the error naming the call), because it is a mistake in the script, not a failed child (`Step 2 stopped: …`, shown in the workflow's detail). Filter with `.filter(Boolean)`. |
| `pipeline(items, ...stages)` | One chain per item, no barrier between stages. A stage gets `(prevResult, originalItem, index)`; the first stage gets the item as `prevResult`; an item whose stage resolves `null` or `undefined` stops there and yields `null`. A stage that throws drops its item to `null` the same way (the reason goes through `log()`) and the other items go on; a misused hook in a stage is re-thrown and fails the run, as in `parallel()`. |
| `phase(title)` | Move the global phase cursor. A title matches a declared one ignoring case; an empty title throws. |
| `log(message)` | A progress line (at most 2000 characters). |
| `args` | The JSON you passed to `run()`. |
| `budget` | `{ total, spent(), remaining() }`. `total` is `limits.tokenBudget` or `null`; `spent()` is the tokens this run's agents have used, refreshed on each `agent()` result; `remaining()` is `max(0, total - spent())`, or `Infinity` with no target. It is a hard ceiling: once `spent()` reaches `total`, `agent()` throws a `WorkflowBudgetExceededError` (agents already running finish), `pipeline()` throws at its start, and inside `parallel()` / `pipeline()` the throw drops the slot to `null` with one summary line. `tokensUsed` and `tokenLimit` remain as deprecated aliases. Guard loops on `budget.total` and give them a hard iteration cap. |

`meta.whenToUse` and `meta.phases[].model` are accepted (and limited to 500 and
120 characters) and are not applied: nothing reads `whenToUse`, and a phase's
`model` does not choose the model of its agents. An agent's model is the
`model` option of its own `agent()` call, else the host's default.

`return` supplies the result. There is no `require`, `process`, `fetch`, timer
or `import()`. This version leaves out nested `workflow()`, worktree isolation and
named workflows. A run can be [resumed](#resuming-a-run) from its journal.

### When a script fails

A script that throws, or does not parse, fails the run. `WorkflowRunResult.error`
(also the `error` of `workflow_finished`) is written for the model that
authored the script, so it can repair it instead of guessing:

```
TypeError: not a function — line 7, column 13: const out = await fn(items)
Before it failed: 3 agents started, 2 finished, 1 failed. A rerun starts the whole script again, so finished agents run again. Last phase: "Fix".
```

A host that passes `canResume: true` (it keeps a journal and can resume) gets "Resume the run to continue: agents whose prompt and options are unchanged return their saved results." in place of the rerun sentence.

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
enforcement; the host still validates every `agent()` request. An unknown `agent()`
option (a misspelt `lable`) is still ignored, as before, but a `log()` line now says so.
These misuse errors are marked, so `parallel()` and `pipeline()` re-throw them
rather than mapping them to `null`.

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
validate (unknown request key, non-string label, schema over 32 KiB). The host
re-validates every call, so a compromised prelude cannot widen the bridge.
`log()` and `phase()` lines share a 256 KiB output budget; later lines are
dropped and `logsTruncated` is set.

## Phases

A phase is a title the script chooses. Titles in `meta.phases` are announced
first, in declared order. `phase(title)` moves the global cursor;
`agent(..., { phase })` assigns explicitly, which avoids races on the cursor
inside `parallel()` or `pipeline()`. The same title (after trimming and
collapsing whitespace, and ignoring case) is the same group, and the index is
first-seen order starting at 1. The spelling kept is the first one seen, which
is the declared one when the title is in `meta.phases`; `meta.phases` refuses
two titles that differ only by case. A journal written before titles were
matched ignoring case is read by index and is unaffected; resuming one runs the
script again, so its `phase()` calls group by the new rule, and a script whose
`meta.phases` has two case-only twins is refused until one is removed. An agent with neither a cursor nor an explicit phase has no
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
preview, error), `log` and `run_finished`. `writeScript(source, sha256, pass)`
is called first with the exact script. A journal that fails never stops the
run; the first failure is reported as `journalError`.

Records carry what resuming needs, all optional so an older reader keeps
working: `agent_request` and `agent_outcome` have a `key` (see below) and the
`pass` they belong to (1 for the first run); `agent_outcome` has `result`, the
agent's full value after schema validation (finished agents with a non-null
value only), `unsaved` when a value could not be saved, `interrupted` when the
run or the agent was stopped before it finished, `childSessionId` when the host
reports where the agent ran (`WorkflowAgentOutcome.sessionId`), and, for an
agent that returned a saved result instead of running, `cached: true` with
`resultFrom` pointing at the pass and index that first produced it (no
`result`, so values are never duplicated). `run_started` has `resume` (`pass`,
`previousFinish`, `scriptSha256Changed`) on every pass after the first and
`scriptPath` when the host read the script from a file. `run_finished` has
`recovered: true` when a later process marked a run that never recorded its end.

`FileWorkflowJournal(dir, { runId, key? })` writes `script.js` (and
`script.<n>.js` for pass `n` of a resumed run) and an append-only
`journal.jsonl` (files mode 0600) under `dir`, normally
`<session>/runs/<runId>/workflow/`. Every line also carries `seq` and `prev`,
the SHA-256 of the previous line's exact bytes, the first line chaining from a
seed made from the run id. With `key` (a secret the host keeps out of any
folder a tool writes in) each line also carries a `mac`. One writer per file
serves the whole process, writes `run_started`, `run_finished` and saved
results with `fsync`, and drops a late record after a pass's `run_finished`
until the next pass starts. It assumes one process writes a given file at a
time. `read()` takes the run id from `options.runId`, else from the file's first
`run_started`, else from the folder's parent name, so a journal in a folder of
your own choosing reads back whole. Each saved result is at most
`limits.maxValueBytes` (1 MiB by default); `read()` loads the whole file, so
read journals of very long runs off the interactive path.

## Resuming a run

A run keeps its id and appends to the same journal. `read()` returns the
records that passed the integrity check, `loadWorkflowResume()` folds them
into what the next pass needs, and `resume` hands it to the runtime:

```ts sketch
const journal = new FileWorkflowJournal(dir, { runId, key })
const resume = loadWorkflowResume(await journal.read())
if (resume.resumable) {
  await new WorkflowRuntime().run({
    script, runId, journal, resume, deterministic: true, canResume: true, spawnAgent,
  })
}
```

Each `agent()` call has a key, `workflowCallKey(prompt, call, ordinal)`: a
hash of the prompt, the options that change what the agent does (`schema`
content, `model`, `effort`, `agentType`) and how many identical calls came
before it in the pass. `label`, `phase` and progress callbacks are not part of
it. A call whose key has a saved result returns it without running: no agent,
no tokens, an `agent` event with `cached: true`; it still counts toward
`maxAgents`. The cache stays valid until the first call that was never seen,
failed, was skipped, or was asked for again without finishing; from that call
on, in every branch of the script, agents run again. Calls that were queued or
running when the run was stopped, and agents cut off by a stop, a closed
session or the token budget, are recorded as `interrupted`: they run again but
do not end reuse. So does a call that was asked for and has no recorded outcome
at all (it was queued, or running when the process was killed): it runs, and
later calls with a saved result still return it. Only a call that failed, was
skipped or is new ends reuse. Editing a call changes its key, so an edit ends reuse at that
point. Parallel and pipeline slots start in slot order, so reuse is decided in
that order.

The chain finds a line that was edited, removed, swapped or inserted (the next
line no longer chains), and a last line cut off mid-write (ignored; one that is
whole JSON and only lacks its newline is read like any other line). It cannot
see an edit to the final line, or a rewrite of the whole file, without `key`;
with `key`, anyone without the secret cannot make a line verify. A pass picks
the chain up again at the last trusted line, so a damaged region is reported
(`brokenAt`, in `problems`) but later passes compound. A journal written before
chaining reads as `legacy` and is not resumable.

`deterministic: true` makes the script repeatable, which a resume needs:
`Date.now()`, `new Date()` with no argument, bare `Date()` and `Math.random()`
throw with a message that says what to do instead (`new Date(x)`, `Date.parse`
and `Date.UTC` work), and `eval` is removed. The default is `false`, so existing
embedders are unchanged. A result in a resumed pass is the value the earlier
pass returned for the same prompt and options; it does not notice that a
session default model changed.

## Process boundary

The interpreter gets the script, `args` and a small prelude that defines the
globals above and removes the two bridge natives from the global object. The
only message the worker can send that the host acts on is the `agent` call;
`phase()` and `log()` are printed JSON lines, which the host treats as
untrusted text. See [Bounded code execution](code-execution.md) for what the
interpreter withholds and what its tests establish.
