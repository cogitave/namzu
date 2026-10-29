---
'@namzu/cli': minor
---

`namzu exec` takes two new flags. `--fork-session`, with `--continue` or `--resume <id>`, carries on in a copy of that conversation and leaves the original untouched. `--no-session-persistence` keeps no record of the run: the conversation is removed when the run ends, and a resumed conversation is worked on as a copy that is removed too. `exec --json` and resident work refuse both. Nothing to change to keep working; without the flags every run is recorded as before.
