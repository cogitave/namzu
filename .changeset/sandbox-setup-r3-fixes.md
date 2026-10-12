---
"@namzu/sandbox": patch
---

Harden the Windows Pal computer setup (`@namzu/sandbox/local-virtual-computer/setup`).
Every readiness probe now has its own time limit and a stuck one no longer hangs
`inspectWslcReadiness`: it becomes an unknown fact, or a `LocalComputerSetupError`
with a plain message when the state cannot be decided. An unexpected `wslc` failure
during a session probe is now that error instead of `image-missing`. A PC that has
not restarted since Virtual Machine Platform was turned on reads `restart-pending`
(not `virtualization-off`), and an unreadable restart record reads `restart-pending`.
The processor type comes from the PC, wslc is found under `ProgramW6432`, and the
image-load estimate is shorter. `WslcSetupHost` gains `keyExists`; implement it if
you pass a complete host (a partial `host` override is unaffected). A failed
`runWslcSetup` result may carry `exitCode`, and its `detail` no longer includes the
number. `LocalCommandError` gains an optional `exitCode`, and the provider's
`probe()` returns `setupCode` beside `reason`. The engine-missing message now reads
"Linux container support is not installed on this PC." (it no longer names wslc);
match on `code`, not on the text.

A registry key that Windows would not let the setup read is no longer taken for one that is not there. That applies to the sign-in resume entry and to the pending-restart markers, so a PC that only needs a restart is no longer told its virtualization is off. An unreadable restart record now ends with the next restart instead of never. With a session probe, the pending-restart markers are not consulted and `0x80370102` stays `virtualization-off`. The Pal computer probe reports a setup code only for a setup failure.
