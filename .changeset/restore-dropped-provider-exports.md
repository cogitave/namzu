---
'@namzu/sdk': patch
---

Restore two provider-classification helpers that 3.0.0 dropped by accident.

`classifyProviderHttpStatus` and `bodySaysContextOverflow` were part of `@namzu/sdk`'s public surface in 2.0.0. Reconciling a long-running branch resolved a conflict in `public-runtime.ts` in the branch's favour, which discarded both exports, and 3.0.0 shipped without them. They are back.

Neither was removed on purpose and nothing in 3.0.0's notes claims otherwise. They exist for a driver outside this repo that needs the classification the first-party drivers use: a status code alone does not separate a context overflow from an ordinary bad request, and re-deriving that per driver is how classifications drift apart.

The gate that should have caught this now does. It compares `baseline - current`, so a name that never entered the baseline was invisible to the removal check — it could be added, dropped, and still report "intact", which is exactly what happened. Widening the surface is now a failure that demands the baseline be regenerated in the same commit, rather than a warning that let the baseline go stale.
