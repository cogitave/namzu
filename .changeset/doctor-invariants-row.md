---
'@namzu/cli': minor
---

Add a `runtime.invariants` row to `namzu doctor`

Reads `@namzu/sdk`'s new module-attributed invariant registry (`InvariantRegistry`, NZ-BOOT-03) and reports what this build claims about its own live state: the registered set, each invariant's outcome right now, and its accumulated violation counter.

`unknown` — a check that could not be evaluated, which is what both of the SDK's shipped invariants correctly answer outside a live run, since `namzu doctor` has no compaction pass or run claim to point them at — is reported as `inconclusive`, never `pass`. Any `violated` invariant fails the row, and a failed row fails the whole report (`exit 1`, same as any other doctor check).

**What this means for a script that runs `namzu doctor` and checks its exit code:** on a normal machine, with no run in flight, the new row will read `inconclusive` rather than `pass`, which — per this command's existing exit-code table — moves the report's exit code to `69` unless something else already failed it to `1`. This is new for any caller that previously got `0` from a clean `namzu doctor` run outside of an active session.

New doctor check: `invariantsCheck` (id `runtime.invariants`), added to `builtInDoctorChecks`. New export: `describeInvariants(registry)`, so a host can drive its own `InvariantRegistry` rather than the process-wide singleton.
