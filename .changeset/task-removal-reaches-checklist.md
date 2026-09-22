---
'@namzu/sdk': minor
'@namzu/cli': patch
---

A task removed with `task_update` status `deleted` is now distinguishable on the stream: its `task_updated` event carries `deleted: true` (the SSE `task.updated` event too), with the subject and status the task had when it went. Before, a removal arrived as an update that changed nothing, so the interactive terminal kept drawing the removed task as an open step in the checklist. It now drops the task and writes `Removed task · <subject>`. The field is optional and absent on every other update; a consumer that ignores it sees the same events as before.
