---
'@namzu/sdk': major
---

A pause raised from a tool through `ToolContext.requestPause` can now be answered after the process that raised it is gone. It could not before, on any surface, and the failure was silent.

Three things stood between the pause and its answer, and all three are fixed.

**The resume gate could not open.** A pause is identified by `<toolUseId>:<name>` — the name is there so one call can ask "which environment" and then "are you sure" without the second answer landing on the first question. The gate that decides whether a parked answer belongs to this turn compared that whole id against a raw tool-use id, which it can never equal. So every cross-process resume of such a pause was refused, and the run fell through to the repair that strips the parked turn and asks the model to decide again — turning a human's answer into "ask again and hope". The gate now matches the call portion while the full id continues to route the answer.

**The pause wrote nothing durable unless you used `SupervisorAgent`.** The recorder and the answer channel arrived only from the `questionParks` and `pendingAnswers` run parameters, and neither type is exported, so no host could supply them. On `ReactiveAgent`, `drainQuery` or `resumeRun` the pause was an in-process `await` that reported itself as durable. A run now supplies its own when the host supplies none.

**What changes for you.** If you call `requestPause` on any surface other than `SupervisorAgent` and you have a `checkpointStore` configured, that pause now writes a real checkpoint and emits `user_question_asked` / `user_question_answered`, where it previously wrote and emitted nothing. An approval queue built on `findPendingCheckpoint` or `listDurableRuns` will start listing these runs as parked — which is the point, and is also new rows in a view you may already be rendering.

There is no flag to keep the old behaviour, because the old behaviour was the defect: a pause that reports itself durable and is not. If you do not want a durable park, do not call `requestPause`.

**If you built your own durability around this,** threading a recorder into a private tool builder to work around the missing seam, remove it. The run records the park itself now, and a host recorder plus the run's own records it twice — two checkpoints for one question, and an approval queue that serves the second after the first is answered.
