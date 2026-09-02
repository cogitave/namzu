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

Orchestration primitives, all **developer-authored**.

- **`PipelineAgent.ts`** — a fixed step list the developer wrote. The steps
  run with **zero model turns between them**: the control flow is code, and
  the model is called only where a step calls it.
- **`SupervisorAgent.ts`** — delegation driven by the model emitting
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

## The decided position: control flow is authored by a developer

A model may choose *what* to do — which tool, which delegate, in what order
within a turn. It does not author the *program* that runs those choices.

The proposal this rules on is a model-emitted orchestration SCRIPT —
`agent()`, `parallel()`, `pipeline()` as globals — executed in an isolate, so
that logic between steps costs no model turns. It is refused, and the reason
is the trust boundary rather than the feature's value.

**The argument.** `bash` from a model is mediated by `packages/sandbox`
because code from a model is untrusted input. A model-authored script is the
same input through a different door, and a strictly more powerful one: it can
call back into the agent surface, spawn delegates and spend budget, which a
shell command reaching only the filesystem cannot. Running it in-process would
leave the kernel's one clearly-drawn confinement boundary covering the weaker
case and not the stronger. So an isolate is mandatory rather than an
optimisation — and once it is mandatory, the capability costs a **second
mediated execution surface** to secure, audit, version and keep in step with
the first.

**What it would buy, measured honestly.** Model turns spent on orchestration
between steps. That is real, and most of it is already available: `PipelineAgent`
spends none, and `SupervisorAgent`'s concurrent `create_task` fan-out spends
one turn for N children. The remaining gap is orchestration a developer did
not anticipate and a model invents at runtime — which is also the case where a
wrong program is hardest to review before it runs.

## The bar a reopen has to clear

Not "someone wants it". Specifically:

1. **A decided trust model**, in writing, before any code: mediated by
   `packages/sandbox` like `bash`, or not at all. "Decide later" is the
   answer this refusal rejects.
2. **A second execution surface worth its own maintenance** — its own
   confinement, its own audit records, its own version story. If the answer
   is "reuse the sandbox", show how a script that calls `agent()` is confined
   by a boundary designed for a subprocess.
3. **A measured gap**, against `PipelineAgent` and concurrent `create_task`
   rather than against a single sequential agent. The comparison the original
   proposal made was to the wrong baseline.

Recorded in `ses_020`'s decision log as D5. If the owner reverses it, replace
this section rather than adding to it — two stances in one file is how the
first one got lost.

## Working here

- An agent's capabilities are **declared** on its metadata and honoured by the
  runtime. Adding a capability means declaring it and driving it in the same
  change; a declared capability nothing reads is the
  `declared-but-undriven` defect this repo has a convention page about.
- `AbstractAgent` takes an injected `Logger`. Do not reach for
  `getRootLogger()` here — see the log-standard gate,
  which counts every call site.
