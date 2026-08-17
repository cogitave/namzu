---
'@namzu/sdk': major
---

Three deprecation windows opened by NZ-RUNREC-10, -11 and -13 close here. 28.0.0
carried all three; this release acts on them.

**`AgentStatus` is removed.** Use `RunExecutionStatus`. It was an alias with an
identical union — the rename existed because the name described the wrong
subject: every use was a run's status, and an agent has none of its own. Rename
the import and nothing else changes.

**`SubSessionStatus` narrows to the five driven variants** and is now an alias
of `SubSessionDelegationStatus`: `pending`, `active`, `idle`, `failed`,
`archived`. The six merge variants (`awaiting_merge`, `pending_merge`,
`merging`, `merged`, `merge_conflict`, `merge_rejected`) had no producer
anywhere and are gone. Drop any switch case for them; a `default` that handled
them still compiles.

`ARCHIVABLE_STATUSES` loses `merged` and `merge_rejected` with them. They were
kept one release because a host could have persisted one while the union was
wide; if you have such a record, migrate it to `idle` or `failed` before
upgrading, or it becomes un-archivable.

**`SingleHandoffDeps.runStatus` and `BroadcastHandoffDeps.runStatus` are
required, and `NOOP_RUN_STATUS_RESOLVER` is removed.** The default it supplied
answered `null` for every session, so the non-terminal-run fan-in check on
handoff could not fail — a lock was allowed while a run was still going, and
nothing said so. Pass `createRunStatusResolver(store)`, or, if you genuinely
want no fan-in check, your own always-null resolver — deliberately, and visibly
at the call site.
