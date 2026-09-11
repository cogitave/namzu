---
"@namzu/cli": minor
"@namzu/sdk": minor
---

Add experimental `namzu resident` commands to save, inspect, execute, pause, resume, wake, reconcile and archive project-bound pursuits. Execution reuses the configured CLI runtime, requires a finite step cap and defaults to read-only plan mode; provider/tool/token options apply to each invocation or SDK step as documented. Saved execution directories, last-step summaries and private attempt receipts survive reopening. Interrupted work retains its exact claim and requires explicit inspection before reconciliation; no service, automatic replay, external messaging or ordinary TUI default is enabled.

Add an optional durable `pauseGeneration` to resident agendas. Each successful `setPaused(true)` increments it, and resume preserves it, allowing a CLI runner to notice even a rapid pause/resume between local checks. SDK agenda writes use schema 5; schemas 1–4 remain readable with an absent generation interpreted as zero. Older writers refuse the new schema rather than drop stop authority. SDK hosts remain opt-in; existing local `ResidentHost.pause()` behavior is unchanged.
