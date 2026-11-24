---
"@namzu/cli": minor
---

Teammates run. With `teams.enabled` on (or `NAMZU_TEAMS=1`, or `--teams`), an `Agent` call that gives a `name` starts a teammate instead of a one-shot sub-agent: a helper with its own conversation inside your session that goes idle between turns, wakes on mail from the lead or another teammate (`send_message`, labelled as another session, never as you) or on the lowest ready task of the team's shared list, and ends after `teams.idleExitMinutes`. The lead and every teammate work from one task list under their own names. `teams.maxTeammates` is enforced with a plain refusal. With teammates off, or without a name, nothing changes. In a conversation with teammates on, the lead's own task list is the team's list, so its tasks outlive the session in `~/.namzu/tasks/`.
