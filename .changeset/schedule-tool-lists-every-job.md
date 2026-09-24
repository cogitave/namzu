---
'@namzu/sdk': minor
'@namzu/cli': patch
---

In the TUI, the model's `schedule` tool now lists every scheduled job, not only those of the session's folder. A model that created a job in a folder below the session's and then called `list` was told "No scheduled jobs." while `namzu schedule list` showed the job, because the TUI's host filtered by folder unless the model passed `allFolders: true`, which models do not. Jobs of the session's own folder are marked `(this folder)` and are still the only ones whose prompt the model sees.

SDK: `ScheduleJobSummary` gains an optional `inSessionFolder`, which the `schedule` tool prints as `(this folder)` on the job's `list` line. A host may use it to list every job regardless of `allFolders`. The tool still asks `host.list({ allFolders: false })` unless the model sets it, so a host that filters by folder behaves as before.
