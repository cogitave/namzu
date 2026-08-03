---
'@namzu/sdk': minor
---

Make compaction actually fire, and make it observable.

The trigger divided the current context size by `runConfig.tokenBudget` whenever
`contextWindowTokens` was absent — which was always, since nothing in the estate
ever set it. Those are different quantities: `tokenBudget` is a cumulative spend
cap, and comparing a live window against it is self-defeating, because the guard
force-finalizes at 0.9x that number while compaction needs 0.7x of it. With the
shipped CLI's `tokenBudget: 1_000_000` the trigger sat at ~700k. The entire
subsystem — working state, extractor, serializer, dangling repair, verifier —
was armed and never fired.

- The divisor is now always a context **window**: `contextWindowTokens` when the
  host sets one, otherwise resolved from the model id via a new
  `resolveContextWindow` / `lookupContextWindow`, otherwise a conservative
  128k default. `tokenBudget` is never the divisor.
- Context size prefers the provider's own `promptTokens` from the last turn — a
  measurement that includes tool schemas, system blocks and image tokens — over
  the chars/4 heuristic, which remains the fallback before the first turn
  reports. `RunPersistence.recordTurnUsage()` records it; side-channel calls
  keep using `accumulateUsage()` so they cannot corrupt the signal.
- Two guards (the thrash guard and prior-summary replacement) were gated behind
  `contextWindowTokens != null` to preserve the legacy path byte-for-byte. That
  path's actual behavior was "never fires", so the gates are removed — otherwise
  a consumer that now compacts would accumulate one redundant summary per pass.
- New `compaction_completed` run event (wire: `compaction.completed`) carrying
  before/after message counts and token sizes, whether the size was measured or
  estimated, and which window was used. Compaction deletes history
  irrecoverably and previously emitted nothing at all.
