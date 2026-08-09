---
'@namzu/sdk': major
'@namzu/cli': major
---

`namzu doctor` no longer exits 0 when a check could not answer

**What breaks.** `namzu doctor` gains a new exit code, `69`, and a new status
word, `skipped`.

- **A CI step running `namzu doctor` can now fail where it used to pass.** If a
  check times out, is aborted, or the thing it reads throws, the command exits
  `69` instead of `0`. Nothing is claimed to have failed — `1` still means that
  — but the report is incomplete, and it used to say so only in text nothing
  reads. If you need the old behaviour while you look into it, treat `69` as
  success explicitly rather than by accident.
- **`DoctorStatus` gains `'skipped'`.** An exhaustive `switch` over it, or a
  `Record<DoctorStatus, …>`, stops compiling. Handle `skipped` as "there was
  nothing here to check" — an ordinary state of a healthy machine, not a
  problem.
- **`DoctorReport['exit']` gains `69`**, and `DoctorReport['summary']` gains a
  required `skipped: number`. Code that constructs a `DoctorReport` by hand must
  add the field; code that reads the summary can now rely on the counts summing
  to `total`, which they did not while `skipped` was hidden inside
  `inconclusive`.

**Why.** "Healthy" and "did not manage to look" shared an exit code in the one
command whose entire job is to report state it read. Fixing that needed the
status vocabulary split first, because `inconclusive` was carrying two facts:
*there is nothing here to check* — an optional package absent, a registry with
no auto-discovery, nothing configured yet — and *this check did not answer*.
Only the second is a gap worth an exit code; making both non-zero would have
turned `namzu doctor` red on every healthy machine.

So `vault.registered`, `providers.registered`, `providers.chain` with no
preferences file, and `telemetry.installed` with the package absent now report
`skipped`, and they still exit `0`.

**Also fixed:** `telemetry.installed` reported `not installed (optional
package)` for *any* import failure, so a package that was present and threw on
load was reported as absent. Resolution and loading are now asked separately —
cannot resolve is `skipped`, resolves but throws is `fail`, with the reason.

**Why 69 and not 2.** `2` already means "no checks registered" here. `namzu
eval` spells the same idea `2`, which it can because it never spent that number
on anything else; giving one number two meanings inside one command is worse
than giving one meaning two numbers across two. `69` is sysexits
`EX_UNAVAILABLE`.
