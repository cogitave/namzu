---
'@namzu/cli': minor
---

A scheduled run that completed with refused tool calls now says so. A job whose only command was refused on every run was recorded `completed` each time, with a `finished` notification and nothing else to go on.

A run now records `refusedCalls` (calls that never ran: a permission rule, the scheduled-run floor, `unmatched: deny`, a tool its permissions withhold) and `failedCalls` (calls that ran and returned an error), each `{ count, first: { tool, reason } }`, in its result file and history record, and as counts in the job state's `lastRun`. `namzu schedule list` shows `last completed (1 call refused)`, `show` and `history` print the first reason under the run, `run-now` prints it, and so do `/schedule` and the model's `schedule` tool `list`. The finished notification reads `done at …, but 1 call was refused (bash); namzu schedule show <job> says why`; the reason itself appears in the notification only for a job created with `--notify-summary`, because it can quote the command the model wrote.

The run's status is unchanged: `completed` still means the turn ended normally, so failure counting, automatic pausing and which notification is sent behave as before. The new fields are additions to the `--json` output of `list`, `show` and `history`.
