---
'@namzu/cli': minor
---

Add scheduled jobs: prompts that run later in a folder while namzu is closed, under a permission set you write down, run by a scheduler service.

New commands, all under `namzu schedule`: `add`, `edit`, `confirm`, `list`, `show`, `history`, `pause`, `resume`, `remove`, `run-now`, `prune`, `install`, `uninstall`, `status`, `start`, `stop`, `logs` and `daemon`. `install` registers a systemd user unit, a launchd agent or a Windows scheduled task (under WSL, a task that runs the daemon through `wsl.exe`). New config key `schedule` (`maxConcurrentRuns`, `notifications`), read from the user and managed files only. New files under `NAMZU_HOME/schedule/`. `namzu doctor` gains a `scheduler.service` check. `namzu upgrade` asks a running scheduler to restart on the new code.

In the TUI: `/schedule` lists jobs and what needs you and acts on them, `/loop` re-sends a prompt to the open conversation on an interval between turns, the model gets a `schedule` tool (every job it proposes is confirmed by you on a screen namzu computes) and a `session_loop` tool, and one startup line reports scheduled work since you last looked.

A job is confirmed only on a terminal or in the TUI; `schedule add --yes` without a terminal creates it inert. A scheduled run never approves a call on its own: a call its rules do not allow is refused or parks for you, and you answer it later from `/resume` in the job's folder, under the job's rules. Allows come only from the job; every `deny` in your config files still holds.

Wording only, no behaviour change: `namzu serve` now says namzu has no *server* (it used to say no daemon, which the scheduler made untrue), and `namzu drain --help` no longer says namzu has no daemon. A script matching the old `serve` sentence must match the new one.

See `docs/cli/scheduled-tasks.md` and `docs/cli/scheduler-service.md`.
