---
"@namzu/cli": minor
---

With teammates on, the terminal shows the team. Each teammate is a row of the agents rail with its name, the task it holds and its state (working, waiting for you, idle, stopped); Enter opens its transcript, what you type there reaches it as a message from you, Esc comes back, and `x` stops it after a second press. Idle rows leave after the whole rail has been idle for 30 seconds and more than three collapse into "N idle teammates"; Ctrl+T shows the team's whole task list with owners and blockers. New `/team`, `/team tasks` and `/team stop <name>` commands. Mail to a teammate is labelled for what it is ("sent to", "task given to", "asked ... to stop") instead of "correction sent", and a teammate that ends its turn leaves one "<name> is idle · finished <task>" row. Only with `teams.enabled`; with teammates off nothing changes.
