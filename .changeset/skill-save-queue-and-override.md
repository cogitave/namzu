---
"@namzu/cli": patch
---

`/skills save off` and `/skills save on` now warn when a project file, profile or managed config sets its own `skills` block that would override the value you just wrote to `~/.namzu/config.yaml`. The warning names that file and says what `skills.suggest` will be the next time namzu starts. Add `suggest` under `skills` in that file to make the change stick. `/skills save` and `/skills new` typed while a turn is running now wait and run when that turn ends, instead of being injected into it.
