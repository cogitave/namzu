---
'@namzu/sdk': major
---

**The turn that produces the answer is now in the step ledger.** It was not.
`if (forceFinalize || !hasToolCalls)` broke out of the loop before
`recordStep`, so the ledger held only turns that called tools — and a run's
last turn is its most expensive, because it carries the whole conversation as
its prompt.

**Why this is a fix and not a redefinition.** `StepResult` is documented as
"what one iteration of the agent loop did" and `stepNumber` as "1-based,
matching `iteration` on the run events". Every skipped turn emitted
`iteration_completed` with its number, so the events said iteration N happened
and `steps` had no entry N. The invariant was already false; nobody had chosen
"turns that called tools" as a meaning.

Measured on a two-iteration run — one tool call, then an answer — **220 of 330
tokens belonged to no step**, and the unattributed share grows with context
length. A text-only run, which is the commonest shape there is, produced an
empty ledger.

**What changes for you.** `run.steps.length` gains one entry for every run that
ends by answering, and `onStepFinish` fires once more per run. Nothing stops
compiling; the values change:

- **If you compare step counts across this version, they shift by one.** A
  recorded baseline is not comparable — `stepBudgetScorer` in the eval harness
  is the in-tree example, and its own note says it exists because extra turns
  are "very visible on the bill". It was undercounting the bill by exactly the
  most expensive turn, so its new number is the correct one.
- **Trajectory scorers are unaffected.** The added step has no tool calls, so
  `steps.flatMap(s => s.toolCalls)` is unchanged.
- **`stopWhen`, `stepCountIs` and `hasToolCall` are unaffected in-run.** The
  predicate is consulted only after a tool batch, and the answering turn ends
  the loop before it.

Also recorded now: the auto-continued turn after an output cutoff, the
structured-output re-prompt, and an answer handed back by `reviewAnswer`. All
three spend a turn and none of them left a trace.

**Still not steps:** side calls. Compaction verification, the advisory
executor and the retry after an empty completion spend tokens inside an
iteration without being one, so they reach `run.tokenUsage` and no step. A run
that makes them reconciles short by exactly their cost. Attributing those needs
a record that is not a step, which is a separate change.
