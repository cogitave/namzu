---
'@namzu/sdk': patch
'@namzu/cli': patch
---

The `schedule` tool's input schema now says that `budget` limits one run and that `maxIterations` counts model steps, not repetitions of the job. A model proposed `maxIterations: 1` for a job meant to post once per run, and every run stopped after its first model call. The CLI's confirmation of a job, on a terminal or in the TUI, warns when it allows fewer than 10 iterations.
