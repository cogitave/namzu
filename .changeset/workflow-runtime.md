---
'@namzu/sdk': minor
---

Add `WorkflowRuntime`, which runs a model-authored workflow script: a JavaScript program, written once, that decides how many subagents run and in which order (`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`). The script runs in the same QuickJS interpreter as `run_code`, and `agent()` is its only capability; your `spawnAgent` callback decides what starting an agent means, so it can go through the same policy and accounting as your own delegation. New exports: `WorkflowRuntime`, `parseWorkflowMeta`, `summarizeWorkflowPhases`, `FileWorkflowJournal`, `WorkflowScriptError` and the `Workflow*` types (events, limits, journal records, results). Nothing existing changes behaviour. `RunCodeOptions` gains two optional fields, `cpuLimits` (bound synchronous interpreter time per stretch and in total instead of the whole run's wall clock) and `onOutput` (each printed line as it is printed); a custom `CodeRuntime` may ignore both.
