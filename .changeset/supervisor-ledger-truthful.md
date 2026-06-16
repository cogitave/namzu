---
'@namzu/sdk': patch
---

The supervisor's task ledger no longer fabricates success for workers that
produced no result. Previously, when a task handle had no `result`, the
synthesized entry took its status from `handle.state` (cast to a terminal
type) — so a handle reporting `state: 'completed'` but carrying no result was
counted toward `completedTasks`. The supervisor then reported "workers done"
with empty outputs when the workers never actually produced anything.

An absent result is now always synthesized as a terminal `'failed'`, so it can
never count as a completed task. Handles that carry a real `result` are
preserved verbatim, so genuine workers are unaffected. The synthesis and tally
are extracted into `synthesizeTaskResults` / `countCompletedTasks` and covered
by unit tests.
