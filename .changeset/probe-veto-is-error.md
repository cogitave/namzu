---
'@namzu/sdk': patch
---

A tool call a probe vetoed now says it failed.

The probe-veto branch was the only result-producing branch in the executor
that left `isError` off, and `isError` being optional meant the compiler
could not catch it. Five lines above, the `tool_completed` event for the
same veto carried `isError: true` — so a run's event stream and the result
it returned disagreed about the same call, in the same function.

Four things degraded off that one omission:

- Two drivers emit their failure marker only when this is true, so the model
  read a **successful** result whose body begins `Error: Probe "x" vetoed…`
  and the failure-recovery path it was trained on never fired.
- The persisted step recorded a literal `isError: false`, so the run record
  contradicted its own event stream.
- Compaction guards error results from being cleared; a vetoed result was
  silently excluded from that protection.
