---
"@namzu/sdk": major
---

The kernel now deletes a crash dump once a run that continues it completes.
Before, `EmergencySaveManager.clearSave` had no caller and every dump, each
holding the whole conversation, stayed on disk for good.

**What changes for you.** When a run settles `completed`, the kernel removes
`<runDir>/../emergency/<runId>.json`, its own dump, if one exists. That is the
case for a crashed run resumed under its own id. A host that reads a dump
after its run has completed has to copy it before resuming. A run that fails
or pauses keeps its dump.

New:

- `prepareReplayState({ fromCheckpoint: 'emergency' })` returns the dump's path
  as `emergencySavePath`.
- `query({ supersedesEmergencySave })` names a dump the run continues. It is
  removed when that run completes, which is how a replay forked from a dump
  (under a new run id) clears it. Nothing is removed unless you pass it.
- `EmergencySaveManager.savePathFor(runDir, runId)` names a dump's path; the
  writer and both cleanups use it.
