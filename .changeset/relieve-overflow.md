---
'@namzu/sdk': minor
---

A context overflow now shortens the prompt and retries instead of killing
the run.

`context_length_exceeded` was classified precisely and consumed by nothing.
It is correctly non-retryable — resending the identical prompt cannot help
— so the run died, holding a compaction subsystem that could have made
room.

This is not a hypothetical failure. Compaction fires on an ESTIMATE of how
full the context is, and an estimate can read low: a run carrying images,
or text in a language the chars-per-token ratio does not fit, reaches the
real window while still looking comfortable. The provider then reports
exactly what is wrong, which is stronger evidence than the estimate that
was just proven wrong.

- `relieveOverflow` forces a compaction pass, bypassing the threshold.
- It reports whether anything was actually shed. When nothing was — no
  compaction configured, or nothing left to compact — the error proceeds,
  because retrying would send the same prompt and reach the same error.
- Relief is attempted once per run. A second overflow after a successful
  compaction means the prompt is irreducible, and looping would burn the
  budget to arrive at the same place.
