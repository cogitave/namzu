---
'@namzu/cli': patch
'@namzu/sdk': patch
---

A Desktop conversation now honours the engine settings that Settings saves, the same as `namzu exec`: the longest answer, thinking budget, check before finishing, hook refusals, tokens and spend per task, workflow caps, hand-back, extra folders, hypermode, the refusal fallback, and shedding old results after a long break were saved but ignored there. `exec --json` now reads the workflow caps too. "Forbid auto mode" and "Forbid bypass mode" now remove those modes from the engine's advertised list; the ACP `initialize` answer carries `promptPermissionModes: []` when both are closed (it was left out), so a client can tell that from an older host that sends no list. Nothing to change on your side; a limit you had saved starts to apply in Desktop.
