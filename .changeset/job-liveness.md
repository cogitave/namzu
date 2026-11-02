---
"@namzu/sdk": minor
---

A background job now records when and what it last wrote (`lastOutputAt`, `lastOutputLine`) and can be probed for whether its process still exists (`BackgroundJobRegistry.isAlive`, and `isAlive` on the ref `bindOwner` returns). `judgeLiveness` and `formatLivenessLine` turn those facts into one verdict (progressing, waiting, stalled, dead, finished) with the idle seconds printed; `job` with `action: "list"` prints it for each running job, `action: "read"` ends with the time since the last output, and `wait_for_job` that gives up says how long the job had been silent instead of "for a while".

Monitor events, a monitor's end, a job's exit notice and a task completion notification (`finished_at`) now carry their time (`SystemEvent.at` renders as an `at` attribute on the opening tag only when given, so frames built without it are unchanged). A caller that compares the exact text of `job list` output or the "went quiet" line needs to expect the new wording; the additions to `BackgroundJob`, the tool ref and `JobWaitOutcome` are optional or additive for callers.
