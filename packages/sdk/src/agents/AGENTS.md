# AGENTS.md — `packages/sdk/src/agents/`

Nested instructions for work inside this directory. The repository root
`AGENTS.md` establishes that a nested file overrides it here; everything it
says that this file does not contradict still applies.

This file exists because a position kept being attributed to it while it did
not exist. An audit cited `packages/sdk/src/agents/AGENTS.md` as carrying the
stance on model-authored control flow; `find . -name AGENTS.md` returned the
repository root and nothing else. The stance was being inferred from the shape
of the code and re-derived by each reader, which is how a decision turns into
folklore.

## What lives here

The `Agent` contract, `runAgent`/`query` entry points, and an optional
`QueryAgent` adapter are SDK infrastructure. Applications own their agent
identity and orchestration. The CLI's delegated agent lives in
`packages/cli/src/integrations/subagents/NamzuCliAgent.ts`.

`examples/` holds developer-authored orchestration patterns. Their former
exports remain as deprecated compatibility names; they do not define a closed
list of agent kinds.

- **`examples/PipelineAgent.ts`** — a fixed step list the developer wrote. The steps
  run with **zero model turns between them**: the control flow is code, and
  the model is called only where a step calls it.
- **`examples/SupervisorAgent.ts`** — delegation driven by the model emitting
  `create_task` tool calls. Note what this already does: **N `create_task`
  blocks in one assistant turn run concurrently**, so fan-out costs one turn
  for N children, not N turns. The mechanism, checked rather than assumed:
  `tools/coordinator/index.ts` declares `create_task` with
  `concurrencySafe: true`, and `runtime/query/executor.ts` collects every
  concurrency-safe call of a batch into one `Promise.all`.
  Do not read `SupervisorAgent`'s own "one run at a time per instance"
  comment as contradicting this — that is about two overlapping RUNS sharing
  one instance's abort controller, a different question from parallelism
  inside a single turn.
- **`AbstractAgent.ts`** — the base every agent extends; capabilities are
  declared, not inferred.
- **`runAgent.ts`** — the entry a host calls.

## The decided position: a model may author a workflow script, confined

Decided by the owner on **2026-10-18**, reversing the earlier refusal (D5,
which kept control flow developer-authored). The earlier text named the bar a
reopen had to clear: a written trust model before any code, a second
execution surface worth its own maintenance, a measured gap. This section is
the first; the second is the code under `execution/workflow/`; the third is
the table below, measured on 2026-10-18 and not met (see its reading).

A model may choose *what* to do, and it may also author a **workflow script**:
a program run once in the background that decides how many subagents run, with
which prompts, in which order and under which phase titles. The runtime
(`WorkflowRuntime`, `docs/sdk/workflows.md`) schedules them. A workflow's
agents are not subagent rows and not separate notifications; the `Agent` tool
stays the way a model starts one subagent.

### Trust model

1. **The script is untrusted model input**, exactly like a `bash` command
   line. It is never evaluated in the host's Node process.
2. **Confinement is the `run_code` interpreter**, not a new one. The script
   runs in a fresh QuickJS WASM interpreter in a worker thread
   (`execution/code-runtime`, `WorkerCodeRuntime`): no filesystem, network,
   process, module loading or host timers; JSON-only crossings; a memory
   ceiling; source and value size limits; a CPU interrupt on synchronous
   loops. A workflow is a second *bridge* on that surface, not a second
   interpreter. The workflow bridge differs in one respect: it bounds
   interpreter CPU time (per synchronous stretch and in total) instead of the
   run's wall clock while the script awaits its agents, because agents take
   minutes.
3. **One capability: `agent()`.** The bridge admits exactly one host call,
   `agent`. It starts a subagent through the host's own delegation path (the
   same permission mode and rules, sandbox, tool sets, accounting and
   cancellation as the `Agent` tool), so a script cannot widen a grant, pick a
   tool set the `Agent` tool could not, run a command or read a file. Prompts
   are data. `parallel`, `pipeline`, `phase`, `log`, `args` and `budget` live
   inside the interpreter. The host re-validates every call; the in-interpreter
   prelude is convenience, never enforcement.
4. **Review before it runs.** The host (WF2, the CLI tool) shows the script's
   `meta`, the agent cap and the script text, and the operator approves once,
   unless the session is in bypass. Headless sessions with no reviewer refuse
   it unless in bypass.
5. **Opt-in offering.** The tool is offered only when the operator asked for
   orchestration (hypermode, the word "workflow", or a slash command or skill).
6. **Limits.** Concurrent agents `min(8, cpus - 2)` (at most 16); agents per
   run 200 (at most 1000); script source 256 KiB; interpreter memory 64 MiB;
   one bridge value 1 MiB; an optional token budget that stops new agents;
   all with plain errors.
7. **Audit.** Every run is journaled: the script and its sha256, `meta`,
   `args`, one record per `agent()` request and outcome, phase announcements,
   `log()` lines and the final result. Each agent keeps its own transcript.

Not in v1, each a later and separate decision: nested `workflow()`, worktree
isolation, resume from a journal, saved or named workflows.

### The measured gap (WF3, 2026-10-18)

Same two tasks three ways on small fixture repos (a fresh git repo per run, a
checker script for correctness): **2 phases x 3 agents** (scan three packages
for a seeded defect, then fix each; the checker runs the three self-tests and
requires that nothing but the three `index.js` files changed) and a **10-item
pipeline** (extract, then write a derived file per item; the checker verifies
all ten JSON files). Ways: (a) one CLI parent fanning out with labelled `Agent`
calls (the prompt never says "workflow"), (b) concurrent `create_task` through
`SupervisorAgent` and `AgentManager` from the SDK, (c) the `workflow` tool
(`namzu exec --permission-mode auto`, prompt says "use a workflow").

**Real model**, `space-bunny-free` on the keyless Zen free route (every request
went to `opencode.ai/inference/v1/chat/completions` from an `env -i` process
with no credential, and none returned a non-200 in the rows below). Frozen
build `d8a7e2f23`. Median (min-max) over the reps that finished:

| Task | Way | Reps | Parent requests | Parent tokens | Child requests | Child tokens | Wall time | Correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 phases x 3 agents | (a) `Agent` fan-out | 2 | 7 (7-7) | 117,761 (116,263-119,259) | 23 (23-23) | 181,040 (174,347-187,732) | 60 s (57-62) | 2/2 |
| 2 phases x 3 agents | (b) `create_task` | 2 | 6 (5-6) | 34,428 (28,171-40,685) | 31 (29-32) | 153,850 (142,475-165,224) | 46 s (43-49) | 2/2 |
| 2 phases x 3 agents | (c) workflow | 2 | 9 (7-11) | 150,984 (111,614-190,354) | 20 (19-21) | 152,263 (147,307-157,219) | 51 s (45-56) | 2/2 |
| 10-item pipeline | (a) `Agent` fan-out | 2 | 9 (7-11) | 188,078 (150,833-225,323) | 56 (46-65) | 426,912 (352,653-501,170) | 62 s (56-67) | 2/2 |
| 10-item pipeline | (b) `create_task` | 2 | 8 (7-9) | 69,678 (62,780-76,575) | 76 (70-82) | 356,317 (322,126-390,507) | 83 s (77-88) | 2/2 |
| 10-item pipeline | (c) workflow | 1 | 26 | 604,756 | 291 | 2,348,135 | 213 s | 1/1 |

Not measured: a second (c) rep of the 10-item pipeline. It was rate limited
mid-run (Zen answered 429 with "retry delay at least 20 hours" for every free
model, so no further real-model run was possible that day) and is excluded, not
counted as a failure.

**Scripted model**, same rows, deterministic (the model emits every call of a
stage in one response; tokens are request bytes / 4, so compare ways, not
absolutes): the parent takes **3 requests in every way** for both tasks, and
the fan-out is the same (6 children, 15 child requests; 20 children, 40 child
requests). `Agent` and `create_task` parents spend 41.8k and 44.7k estimated
tokens (CLI parent: a 27-tool prefix of about 12k tokens per request); the workflow
parent 43.7k and 43.9k; the `SupervisorAgent` harness parent 9.1k and 14.7k
because it carries no CLI system prompt or builtin tools, which is a property of
the harness and not of `create_task`.

Sources: parent and child request counts and tokens are summed from the
`message_completed` records of the root session JSONL and of
`<session>/subagents/*.jsonl` (cross-checked against a fetch-recording
`--require` hook: parent + child requests equalled the hook's count of chat
requests in every CLI run); for (b) from the `SupervisorAgent` result and the
same hook (parent = requests offering `create_task`). Wall time is the process's
own, start to exit.

**Reading.** There is no measured gap in the workflow's favour, and on this
model it lost the larger task.

- The two-phase task is a tie. Parent requests (7, 6, 9) and wall time (60, 46,
  51 s) are within each other's range, every run was correct, and the workflow
  parent spent as many or more tokens than the `Agent` parent. The parent's cost
  is the request prefix times the number of requests, and a model offered
  `workflow` still explored first, kept a task list and verified afterwards, as
  the `Agent` parent did.
- With a model that batches the calls of a stage into one response, a fan-out
  needs no more parent requests than a workflow (3 and 3), so the workflow does
  not save requests on a fixed two-stage shape. What a workflow could still
  buy is not exercised here: children returned one line each, so the parent
  context never grew, and there was no failure to repair mid-run. Concurrency
  does not separate them either: the `Agent` parent also ran at most 8 children
  at once (measured from the child sessions' timestamps).
- The 10-item pipeline run took 5 workflow runs. The model's script misused
  `pipeline` (first argument not an array, though the tool description gives the
  signature), asked children for schema-validated JSON that 4 of 10 did not
  produce, and passed `args.ids` as numbers while believing they were strings, so
  its padded file names came out wrong. Each repair re-ran the work, which is why
  child requests and tokens are 5x and 6x the `Agent` way. Whether a stronger
  model scripts it in one run is not measured.
- Caveat on (b): the harness parent has no CLI prompt, so its parent-token
  column is not comparable to (a) and (c).
- Caveat on scale: two reps, one model, two fixtures. The ranges overlap for
  every comparison except the pipeline's workflow row.

If a later change reverses this again, replace this section rather than
adding to it: two stances in one file is how the first one got lost.

## Working here

- `AgentCapabilities` is descriptive metadata. The manager does not enforce
  its booleans. A host enforces tool access, subagent admission and concurrency
  through its toolsets, authorization gate, manager and per-instance locking.
  Do not treat a declared capability as permission or claim it is a runtime gate.
- `AbstractAgent` takes an injected `Logger`. Do not reach for
  `getRootLogger()` here — see the log-standard gate,
  which counts every call site.
