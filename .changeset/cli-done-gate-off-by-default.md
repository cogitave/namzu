---
'@namzu/cli': major
---

`limits.doneGate` now defaults to `false`. Before, the CLI asked a turn that changed files and tried to end without a visible test, lint or typecheck run to check first, in the interactive session, `namzu exec` and the Desktop host; models usually had checked already, and the reminder cost one to five extra requests per run. A turn now ends without that reminder. To keep the old behaviour set `limits.doneGate: true` in the config; the Desktop setting "Check before finishing" now starts off. `--no-done-gate` is still accepted.
