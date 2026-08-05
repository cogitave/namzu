---
'@namzu/cli': patch
---

`run-stream` obeys the permission rules and mode it was given, instead of parsing them and running unrestricted

`[permissions]` was compiled for `namzu run` and never for `namzu run-stream`, so
a host UI ran with an empty rule list whatever the config said. `--permission-mode`
had the same shape one level smaller: the shared parser accepted it, the command
started, nothing failed, and the mode did nothing.

Both are the defect the working-directory fix was about, in the change that was
supposed to be about not making it again: **the run did not fail, it succeeded
while quietly not doing what the operator said.** It is worse here, because the
flag that silently does nothing is a SAFETY flag — someone reaches for `strict`
precisely when they do not trust what the agent might do, and got an unrestricted
run that looked like it had obeyed.

`run-stream` now compiles the same table, resolves the same mode, and refuses a
mode it does not recognise rather than proceeding. A rule that cannot be read is
reported as an in-band error event, which is the only channel a host scanning
stdout has.
