---
'@namzu/sdk': patch
---

A job's exit notice is no longer withdrawn when the `job` read or `wait_for_job` result that delivered the exit was missing output the retention cap had dropped or the bounded result had omitted. The model is still told the job ended. Nothing to change in a host.
