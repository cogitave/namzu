---
'@namzu/cli': major
---

Commands are spelled as words, never with a hyphen, and a scheduler service
command now sits under `schedule service`. The old spellings stop running:
typed, each prints one line naming the new one (and exits 64 on the command
line). Change scripts and habits as follows.

- `namzu schedule run-now <job>` is `namzu schedule run <job>`.
- `namzu schedule install`, `uninstall`, `status`, `start`, `stop`, `logs` and
  `daemon` are `namzu schedule service install`, `uninstall`, `status`,
  `start`, `stop`, `logs` and `daemon`. The job commands (`add`, `list`,
  `run`, `pause` and the rest) stay where they were.
- `namzu state move-legacy` is `namzu state move legacy`.
- `/add-dir`, `/release-notes` and `/terminal-setup` are `/add dir`,
  `/release notes` and `/terminal setup`. Typing only the first word of one of
  them shows the usage of its second word.

One old spelling keeps working on purpose: a scheduler service installed
before this release starts `schedule daemon`, and that form still runs the
scheduler so the installed service does not break. Reinstalling it with
`namzu schedule service install` rewrites it to `schedule service daemon`. A
scheduled run's read-only floor now lets `schedule service status` and
`schedule service logs` through, as it did `status` and `logs`.
