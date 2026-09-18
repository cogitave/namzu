---
"@namzu/sdk": patch
---

Internal module layout only. `query()`'s prelude, its pre-start cancellation
path, its post-loop settlement and its cleanup, the iteration loop's
outstanding-work and step-shaping helpers, and the executor's tool-call
admission family now live in their own modules —
`runtime/query/prepare-run.ts`, `runtime/query/cancelled-before-start.ts`,
`runtime/query/finalize-run.ts`, `runtime/query/release-run.ts`,
`runtime/query/iteration/outstanding-work.ts`,
`runtime/query/iteration/step-shaping.ts` and
`runtime/query/executor/tool-call-admission.ts` — instead of inside
`index.ts`, `iteration/index.ts` and `executor.ts`.

Nothing a consumer observes changes, so taking the upgrade requires no code
change: no export is added, removed or renamed; the `RunEvent` stream carries
the same events in the same order; and budget, checkpoint, HITL and run
lifecycle semantics are untouched. The one shared module surface that moved
is the settle-grace policy (`settleGraceMs` / `awaitedJobGraceMs`'s home —
re-exported from `iteration/index.ts`, so its importers are unaffected).
