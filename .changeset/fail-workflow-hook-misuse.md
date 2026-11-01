---
'@namzu/sdk': minor
'@namzu/cli': patch
---

A mistake in a workflow script's own hook calls now fails the run instead of quietly producing `null` items. Wrong `agent()` arguments, a misspelt `agent()` option (it used to be ignored), a non-object `schema`, a non-function item given to `parallel()` or `pipeline()`, and a bad `phase()` title are re-thrown out of `parallel()` and `pipeline()`; the run ends `failed` and the error names the call. A thunk that throws on its own and an agent that failed still resolve to `null` with a `log()` line. A saved script that passed an option the hooks do not know (for example `lable`) now fails: correct the option name or remove it. The Workflow tool description tells the model the same.
