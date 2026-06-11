---
'@namzu/sdk': patch
---

Plan-rejection guidance now follows the user's feedback instead of baking in
an unconditional revise loop. The old output told the supervisor to "revise
your plan ... and call approve_plan again" even when the feedback explicitly
asked it to stop, so a rejection meant to halt kept generating new plans.
The output now instructs: follow the feedback — revise and re-submit only if
changes were requested; acknowledge and end the turn if asked to stop; ask
the user how to proceed when no feedback was given.
