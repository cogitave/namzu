---
'@namzu/sdk': minor
'@namzu/cli': minor
---

The model can change a scheduled job instead of deleting and recreating it. The `schedule` tool has a new action, `update`: `job` names the job, and only the fields the model sets change (`prompt`, `when`, `folder`, `tz`, `budget`, or `permissions` as the whole new set, under the same limits as `create`). Asked whether it could change a job, a model with no such action deleted the job and created it again, and the job's history was lost.

In the TUI the operator confirms every change on one screen: what changes first (the `-`/`+` lines `namzu schedule edit` shows), a `THE PERMISSIONS CHANGE` warning when a run's rules, `unmatched`, execution or browser grant change, then the job as it will run. `Cancel` is the default. `Save` writes the same job — its id, creation time and history kept — with the operator's new confirmation, keeps a paused job paused, and records `edited by tool` with the changes in its history. A change is refused if the job was changed while the operator was being asked. Like `create`, `update` is not preceded by the ordinary permission review in `prompt`, `accept-edits` and `auto`.

SDK: `ScheduleToolHost` gains three optional methods, `previewUpdate(job, changes)`, `confirmUpdate(request, signal?)` and `update(preview)`, and new types `ScheduleJobChanges`, `ScheduleJobUpdateProposal` and `ScheduleUpdateRequest`. A host without them keeps working: the tool refuses `update` there and tells the model not to delete and recreate the job.
