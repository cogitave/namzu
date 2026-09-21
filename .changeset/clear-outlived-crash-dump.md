---
"@namzu/sdk": minor
---

A run that settles `completed` now removes its own crash dump,
`<runDir>/../emergency/<runId>.json`, if one exists. That happens when a run
that crashed is resumed under its own id and finishes. `EmergencySaveManager.clearSave`
had no caller, so every dump stayed on disk for good. A host that turns on
`emergencySave` for every turn, as the CLI does, collected one dump per crash
or interrupt, each holding the whole conversation. A run that fails or pauses
keeps its dump. A replay forked from a dump runs under a new id and leaves
the source dump alone.

New: `EmergencySaveManager.savePathFor(runDir, runId)`, the one place that
names a dump's path. The writer and the cleanup now use it.

If you read a dump after the run it belongs to has completed, copy the dump
before resuming. Nothing else changes.
