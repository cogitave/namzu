---
"@namzu/sdk": patch
---

Internal module layout only. `query()`'s prelude, its pre-start cancellation
path, the iteration loop's outstanding-work helpers and the run's cleanup now
live in their own modules — `runtime/query/prepare-run.ts`,
`runtime/query/cancelled-before-start.ts`,
`runtime/query/iteration/outstanding-work.ts` and
`runtime/query/release-run.ts` — instead of inside `index.ts` and the
`IterationOrchestrator` class.

Nothing a consumer observes changes, so taking the upgrade requires no code
change: no export is added, removed or renamed; the `RunEvent` stream carries
the same events in the same order; and budget, checkpoint, HITL and run
lifecycle semantics are untouched. The one shared module surface that moved
is the settle-grace policy (`settleGraceMs` / `awaitedJobGraceMs`'s home —
re-exported from `iteration/index.ts`, so its importers are unaffected).
