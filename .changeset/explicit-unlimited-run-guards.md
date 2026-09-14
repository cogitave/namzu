---
"@namzu/sdk": major
"@namzu/cli": major
---

Support explicit unlimited run guards while retaining measured token usage.
Set `tokenBudget: 0`, `maxIterations: 0` and `timeoutMs: 0` in SDK run options,
or in the CLI's `limits` configuration, to disable those three caps. The CLI's
`--token-budget 0` and `--max-iterations 0` now override configured caps; blank,
negative and unsafe numeric values are refused. Omitted defaults are unchanged.

SDK breaking change: `maxIterations: 0` and `timeoutMs: 0` previously prevented
progress; they now disable those guards, consistently with the token limit.
Hosts that used zero to prevent a run from starting must refuse admission or
pass an already-aborted signal instead. Use positive values for finite guards.

CLI breaking change: an explicitly configured `limits.maxIterations` now applies
to built-in subagents too, instead of always giving them 40 iterations. Existing
configurations with a smaller value can stop children earlier; larger values
permit more work. Omit that setting to retain the previous child default (40)
and parent default (50), or define a specialist agent with its own iteration
configuration when the two must differ. The new `limits.timeoutMs` setting also
reaches child runs and blocking delegation tools. `0` does not bypass a finite
ancestor token cap, permissions, operator cancellation or unresolved usage.
