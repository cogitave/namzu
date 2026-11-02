---
'@namzu/sdk': major
'@namzu/cli': patch
---

A mistake in a workflow script's own hook calls now fails the run instead of quietly producing `null` items. Wrong `agent()` arguments (a missing or non-string prompt, non-object options), a non-object `schema`, a non-function item given to `parallel()` or `pipeline()`, and a bad `phase()` title are re-thrown out of `parallel()` and `pipeline()`; the run ends `failed` and the error names the call. A thunk that throws on its own and an agent that failed still resolve to `null` with a `log()` line. A misspelt `agent()` option is still ignored, so a saved script keeps running; a `log()` line now names the ignored option. A script that passed a wrong-typed prompt inside `parallel()` and relied on the `null` must be corrected: it now fails the run, where before it produced `null`. The Workflow tool description tells the model the same.
