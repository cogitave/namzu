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
the table below, still to be measured.

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

### The measured gap (to be filled by WF3)

Same tasks three ways with a real model: (a) one parent fanning out with
labelled `Agent` calls, (b) concurrent `create_task`, (c) the workflow tool.
Recorded per task: parent model requests, parent tokens, wall time, correctness.

| Task | Way | Parent requests | Parent tokens | Wall time | Correct |
| --- | --- | --- | --- | --- | --- |
| 2 phases x 3 agents | (a) `Agent` fan-out | to measure | to measure | to measure | to measure |
| 2 phases x 3 agents | (b) `create_task` | to measure | to measure | to measure | to measure |
| 2 phases x 3 agents | (c) workflow | to measure | to measure | to measure | to measure |
| 10-item pipeline | (a) `Agent` fan-out | to measure | to measure | to measure | to measure |
| 10-item pipeline | (b) `create_task` | to measure | to measure | to measure | to measure |
| 10-item pipeline | (c) workflow | to measure | to measure | to measure | to measure |

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
