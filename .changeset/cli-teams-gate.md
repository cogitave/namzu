---
"@namzu/cli": minor
---

Adds the switch for teammates, off by default and not yet acting on anything: the settings `teams.enabled`, `teams.maxTeammates` (5) and `teams.idleExitMinutes` (30), the `NAMZU_TEAMS` variable (`0` is a hard stop) and the `namzu --teams` flag for one launch. They are read from your own config file and the managed file only, never from a repository, and never apply in one-shot, scheduled or served runs. Settings has a row for each under Helpers and workflows. Nothing changes for anyone who does not turn it on.
