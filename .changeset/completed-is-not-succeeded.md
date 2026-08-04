---
'@namzu/sdk': minor
'@namzu/cli': minor
---

completed is not succeeded — run_completed says why it stopped, and namzu run exits accordingly

`run_failed` is emitted from exactly one place in the kernel: the throw path.
Every other way a run can end badly arrives as `run_completed` — the token
budget, the timeout, the iteration cap, a cancellation, a rejected plan, a
refused structured output, and both guardrails.

Measured: a `max_iterations` stop reports `status: 'completed'`, and the event
carried nothing that distinguished it from an answered question.

**SDK.** `run_completed` now carries `stopReason`. It is optional and additive,
so nothing breaks; a consumer that wants to tell "answered" from "ran out of
budget" no longer has to hold the `Run` alongside the event stream.

**CLI — read this before upgrading if you script `namzu run`.** The command
exited `0` for all of those. The sharp case is the output guardrail: an answer
that was *refused* exited `0` with empty text, so

```sh
namzu run "write the release notes" > notes.md && publish notes.md
```

published an empty file and reported success. `namzu run` now exits `1` when
the run did not finish normally, and names the reason on stderr. The text still
prints — partial output is real output, and a caller who piped it wants what
there is — but `$?` can now say it is partial.

If you have a script that depends on `namzu run` exiting 0 for a truncated run,
it was depending on not being told. Check `$?` and read the stderr line.

Also in the CLI, internally: the `done` agent event's `finishReason?: string`
had no producer and no reader anywhere in the package, and the name belonged to
a different concept — a "finish reason" here is `MessageStopReason`, reported
per model message, not the run-level `StopReason` a caller asks about at the end
of a turn. Replaced by `stopReason`. The type is not exported from the package
entry, so this is internal.
