---
'@namzu/cli': major
---

Workflow scripts launched through the `workflow` tool are now deterministic, so a run can be resumed. This changes what existing scripts may do.

**What breaks.** A script that calls `Date.now()`, `new Date()` with no argument, bare `Date()` or `Math.random()` now fails at that call with a message ("breaks resume"), and `eval` is no longer available. A script that contains an escape byte or a lone carriage return is refused at launch because the review cannot show it. `new Date(x)`, `Date.parse` and `Date.UTC` still work. There is no switch to keep the old behaviour. To fix a script, pass the time through `args` (the caller stamps it), and put an index in the label or prompt when you want independent samples instead of `Math.random()`.

**What is new.**
- `workflow` takes `scriptPath` (a saved script, read fresh on every call; `script` is now optional) and `resumeFromRunId` (continue an earlier run under its own id). Agents whose prompt and options are unchanged return their saved results; the first call that differs, failed or never ran starts running again. The receipt names an editable copy of the script and the exact call that resumes the run, and a failed or stopped run's message says so too.
- A resume goes through the same review as a start and shows which run it continues, what it can reuse and whether the script was edited.
- A run's journal is chained and signed with a key in `~/.namzu/workflow-journal.key`; a run written before this release cannot be resumed (run it again from the start).
- When a conversation is opened again, runs a previous process left unfinished are marked stopped and the model is told once how to resume each (it is not woken for it); `/workflows` shows the pass and the saved results of a resumed run, and `r` on a run that is not going asks the model to resume it.
