---
"@namzu/evals": minor
---

New suite `kernel/hand-back`: seven scripted cases of a model that may hand a task back (at once with further calls scripted after it, after changing a file, in a goal round, in a step with other calls) and of one that does not (doing the task, setting off, a call to the absent tool), scoring whether the turn was handed back and as which kind, the outcome record's verdict, model calls, edits that actually ran, the kernel's closing sentence, whether the tool and guidance were offered, and how a goal round ended. It needs a kernel that exports `HAND_BACK_TOOL_NAME` and `handedBackScorer`; nothing in existing suites changes.
