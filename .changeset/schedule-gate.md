---
"@namzu/cli": minor
"@namzu/sdk": minor
---

A scheduled agent job can carry a gate: one shell command you write, run first in the job's folder, that decides whether the model is called. Set it with `namzu schedule add --gate '<command>'` (or `--gate-file`, `--gate-shell bash|sh`, `--gate-timeout`, and `--no-gate` on `edit`), or in the job file followed by `namzu schedule confirm`. The turn starts only when the gate exits 0 and prints something; its output (capped at 4,000 characters, the cut marked) is handed to the turn as data under "The gate command printed:". Otherwise the run is recorded as the new status `skipped` with its reason (the gate printed nothing, exited with a code, ran out of time, could not start), no model is called, and nothing is spent. The gate has a 30 second default limit, at most 5 minutes, runs on the host with the scheduler's environment minus credential-shaped variables, and is read by the scheduled-run floor and your deny rules like a script job's body.

A skipped run is not a failure: it does not count toward `--pause-after-failures`, sends no failure notice and delivers nothing to a source conversation. A gate that cannot start three runs in a row is told to you once. A job without a gate behaves exactly as before.

What to do about it: nothing, unless you read run statuses yourself. Code that switches on a run's `status` in `schedule show --json`, `history --json` or a job's `state` should treat `skipped` as a finished run that did nothing. A job with a gate is stored as format version 3, which an older namzu refuses loudly. A job that already has one and is later edited by the model's `schedule` tool keeps its gate. In `@namzu/sdk` the `schedule` tool refuses a `gate` input (only a person sets one), and `ScheduleJobPreview` gains the optional `gate` so a host can show the exact command.
