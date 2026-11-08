---
"@namzu/sdk": minor
"@namzu/cli": major
---

A turn that changed files and ends without running anything to check them is now asked once to check first, and the task list is optional.

What changes for you in the CLI: when a model changes files (`edit`, `write`, `apply_patch`, `notebook_edit`) and tries to end the turn with no test, lint, format check, typecheck or build run after its last change, it gets one reminder asking it to rerun its reproduction, run the project's tests and lint, confirm the diff holds only what was asked, and name any throwaway file it made. This is a changed default in the interactive session and in `namzu exec`. To keep the old behaviour pass `--no-done-gate` or set `limits.doneGate: false`. The working doctrine now orders the work as reproduce, change, rerun, test and report, and says a task list is optional; the task-list reminder speaks after 25 model turns without one instead of 10.

In the SDK: `TurnConfig.completionAudit` (off when absent, so an embedding host sees no change) and the same field on agent configs.
