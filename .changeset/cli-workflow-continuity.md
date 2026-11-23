---
'@namzu/cli': patch
---

A workflow run that was cut short because the session closed or you moved to another conversation is now told to the model the next time that conversation is opened, with its run id and the `resumeFromRunId` call; before, a run ended that way was never announced, so "continue" made the model redo the work by hand. `agent_task_list` with `run_id` and `include_output: true` now returns the outputs of that run's agents instead of an error, says when the session holds no such run, and names the run an unknown agent id belonged to. The `workflow` and `stop_task` descriptions tell the model to resume an unfinished run when you say to continue. A stopped turn never stopped a run; that is now covered by a test. Nothing to change on your side.
