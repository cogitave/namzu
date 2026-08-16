---
'@namzu/sdk': patch
---

419 of the SDK's log attribute keys are namespaced, and one of them was naming the wrong thing.

`{ runId }` is now `{ [NAMZU.RUN_ID] }` (`namzu.run.id`), `{ error }` is `exception.message`, `{ tool }` and `{ toolName }` are both `gen_ai.tool.name`, `{ iteration }` is `namzu.iteration`, and so on across 47 files. The bare keys they replace collide with whatever the next feature calls its own `status` or `code`, and they do not sort next to the `namzu.*` / `gen_ai.*` / `exception.*` keys the rest of the telemetry surface already uses — which is the whole reason the rule exists.

Two of the mappings are worth naming rather than listing:

**`sessionId` was a run id.** Four call sites in the iteration phases wrote `{ sessionId: ctx.runMgr.id }`, and `RunManager.id` is a `RunId`. An operator filtering by session id found nothing, and one filtering by run id missed those four records. They now write `namzu.run.id`, which is what the value always was.

**`error` becomes `exception.message`, not `namzu.error`.** Every one of the 77 sites bound a message string — `toErrorMessage(err)`, `err.message`, `String(err)` — so the OpenTelemetry key is the accurate one, and it puts these records under the same key as `exceptionAttributes()` in `utils/log/exception.ts` already produces.

**If you query these logs, your field names change.** The values are untouched; only the keys move. A dashboard grouping by `runId` needs `namzu.run.id`, an alert matching `error` needs `exception.message`. Nothing fails to compile — `LogContext` has always accepted any key — which is exactly why this is worth stating: the change is invisible until a panel goes empty.

`scripts/log-standard.json`'s rule-4 ratchet moves 794 → 375. The remainder is a long tail of keys appearing once or twice in a single module, where the namespace has to come from the module rather than from a shared constant.
