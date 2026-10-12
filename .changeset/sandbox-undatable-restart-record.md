---
"@namzu/sandbox": patch
---

A Windows restart record that cannot be read and has no readable file date no
longer makes the readiness inspection throw `LocalComputerSetupError`. The
inspection now reports `restart-pending` with no `restart` field and no
remaining steps. Callers that caught that error to show "delete restart.json"
now receive a normal readiness result.
