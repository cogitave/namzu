---
'@namzu/sdk': patch
---

Every attribute key the SDK writes to a log record is namespaced. The rule-4 ratchet reaches 0, and with rule 3 already there, both are now floors rather than budgets: the first new bare key in a `Logger` call fails CI, not the hundredth.

This is the long tail after the shared-constant pass — 375 keys across 229 distinct names, almost all appearing once or twice in a single module, where no shared constant applies. They are namespaced by the module that writes them: `namzu.provider.status` and `namzu.run.status` are now different keys, which is the collision the rule exists to stop and which `{ status }` could not express.

Two defects the pass turned up:

**Two emitters of the same event wrote two namespaces for one fact.** The boot-time filesystem migration is logged from `session/migration/filesystem.ts` and again, for the nothing-to-do outcomes, from `runtime/query/index.ts`. Both carry `namzu.migration.completed` as their event name, and a per-module namespace gave them `namzu.migration.kind` and `namzu.runtime.kind`. An operator grouping that event by outcome would have seen half of it. Both write `namzu.migration.*` now.

**The renderer for that event asked for a key nothing writes.** `utils/log/templates.ts` rendered `namzu.migration.completed` as the body plus `namzu.migration.root`, and no emitter has ever produced `namzu.migration.root` — so the operator's migration line appended an empty string. It renders `namzu.migration.kind` now, which is the fact worth seeing: `migrated`, `already_migrated`, or `noop_no_legacy`.

**If you query these logs, your field names change.** Values are untouched; only keys move. `{ reason }` is `namzu.<module>.reason`, `{ charsShed }` is `namzu.runtime.chars_shed`, and so on. Nothing fails to compile, because `LogContext` accepts any key — which is why this is worth stating: the change is invisible until a panel goes empty.
