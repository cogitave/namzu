---
'@namzu/sdk': minor
---

Add programmable stop conditions and a per-step record.

`GuardCoordinator` was the loop's only halt, and it consumes
`{aborted, totalTokens, totalCost, currentIteration, startTime}` — it never
sees messages, tool calls or results. So a terminal `submit_answer` /
`verify_outputs` tool could not end a run: the model had to be prompt-begged to
stop, with `maxIterations: 200` or the token budget as the only backstop, which
meant a finished task still burned its whole envelope. "Stop after three steps
without progress" and "stop when the plan is complete" were inexpressible.

**`StepResult`** records what each iteration did — model, message id, content,
tool calls, tool results, finish reason, per-step usage and cost delta, start
time, total duration and time spent inside tools. Every field was already
computed somewhere in the loop; none of it was reachable, because neither `Run`
nor `BaseAgentResult` had a `steps[]`. A host that persisted the returned `Run`
— the natural thing — permanently lost per-step attribution, and answering
"which step cost the most" meant correlating raw `RunEvent`s by iteration number
and diffing cumulative counters.

- `Run.steps` carries the record, including on a failed run.
- `onStepFinish(step)` fires as each step completes.
- `stopWhen` is evaluated **after** the step's tools have run, so a predicate
  sees what they returned. That ordering is what lets a terminal tool end the
  run *after* executing rather than instead of executing — its output is still
  recorded and still reaches the model's history.
- Helpers: `stepCountIs(n)`, `hasToolCall(...names)`, `anyOf(...conditions)`.
  Conditions may be async.
- A predicate that throws is logged and treated as "do not stop": failing open
  leaves the existing budgets in charge rather than killing a healthy run.
- New `StopReason: 'stop_condition'`.

`runToolReview` now returns its tool outcomes alongside its decision, so the
loop builds the step record from what actually ran instead of re-deriving it
from the messages it just pushed.
