---
'@namzu/sdk': minor
---

Wire up emergency crash-save, and correct the README's claim about it.

`EmergencySaveManager.attach()` had zero call sites: the handler that writes
`emergency/<runId>.json` was never installed, so `replay({ fromCheckpoint:
'emergency' })` read a file nothing ever produced — while the README marketed
"Emergency save on signal" as a differentiator against six competitors and
stated "there is no reliance on the user remembering to catch signals; the
kernel does it."

`query()` now installs the handlers when you pass `emergencySave: true`, and
removes them when the run settles.

It is opt-in rather than automatic, which is a deliberate narrowing of the old
README claim. `attach()` calls `process.on('SIGINT' | 'SIGTERM' |
'uncaughtException')` with handlers that `process.exit()`; a library must not
seize its host's termination path by default, and an API server has its own
drain sequence. The manager is also a singleton whose `attach` detaches
whoever held it before, so under concurrent runs an automatic attach would
silently make the last-started run the only one ever saved. Both READMEs now
say so.

The `namzu` CLI opts in — it owns its process end to end, so Ctrl-C mid-run
leaves a dump under `.namzu/emergency/` instead of losing the turn.
