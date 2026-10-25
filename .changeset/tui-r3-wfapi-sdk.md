---
'@namzu/sdk': major
---

Workflow scripts: `pipeline()` stages now receive `(prevResult, originalItem, index)`; they used to receive `(value, index, item)`. A script that reads its 2nd or 3rd parameter must swap them (`(v, i, item) => ...` becomes `(v, item, i) => ...`); a stage that only uses the first parameter is unaffected. The first stage now gets the item as both `prevResult` and `originalItem`.

Also changed, and worth checking if you set limits: an agent with no `label` is titled with the first 60 characters of its prompt (whitespace squeezed) instead of `Agent N`; the default `maxConcurrency` is `min(16, CPUs - 2)`, at least 2 (was `min(8, CPUs - 2)`, at least 1) and the default `maxAgents` is 1000 (was 200), so pass the old values in `limits` to keep them; `budget` is now `{ total, spent(), remaining() }` and `agent()` throws a `WorkflowBudgetExceededError` once `spent()` reaches `limits.tokenBudget` (it used to resolve `null`), so a script that loops on `agent()` should guard on `budget.total` and catch the error. `budget.tokensUsed` and `budget.tokenLimit` stay as deprecated aliases.
