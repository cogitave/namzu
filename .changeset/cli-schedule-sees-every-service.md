---
'@namzu/cli': minor
---

`namzu schedule list` and the TUI's `/schedule` now show the jobs of every installed scheduler service, each under the service's name after the current home's jobs, and `namzu schedule <show|history|pause|resume|run|remove|edit|confirm> <job>` finds the job by name in the current home and in every service (one match acts on it and says which service; a name found in several homes is refused with the `--service <name>` form). `/schedule confirm|pause|resume|run|remove <job>` act on the service's home too, and a confirmation still needs a person. `schedule list --json` gains a `services` array when services are installed; nothing changes when none is. Pass `--service <name>` or `--home <dir>` to keep acting on one home.
