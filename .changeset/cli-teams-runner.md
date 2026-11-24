---
"@namzu/cli": minor
---

Teammates run. With `teams.enabled` on (or `NAMZU_TEAMS=1`, or `--teams`), an `Agent` call that gives a `name` starts a teammate instead of a one-shot sub-agent: a helper with its own conversation inside your session that goes idle between turns, wakes on mail from the lead or another teammate (`send_message`, labelled as another session, never as you) or on the lowest ready task of the team's shared list, and ends after `teams.idleExitMinutes`. The lead and every teammate work from one task list under their own names. `teams.maxTeammates` is enforced with a plain refusal. With teammates off, or without a name, nothing changes. In a conversation with teammates on, the lead's own task list is the team's list, so its tasks outlive the session in `~/.namzu/tasks/`.

The lead can ask a teammate to shut down (`send_message` with `shutdown: true`); the teammate approves or refuses with `shutdown_response`, and is stopped if it does not answer within the new `teams.shutdownGraceSeconds` (default 20, 1 to 600). Teammates can message each other by name, and 12 messages between teammates in a row without new work are cut off and reported to the lead.
