---
'@namzu/cli': major
---

Three commands changed their spelling, and one is new.

Retired, each now prints one line naming the new form and exits 64 without doing anything:

- `namzu upgrade` is now `namzu update` (same `--check` option).
- `namzu login <claude|codex>` is now `namzu auth login <claude|codex>` (same `--no-browser`, `--code` and `--timeout`).
- `namzu logout [provider]` is now `namzu auth logout [provider]`.

Change any script, scheduled task or CI step that runs the old names. The `/login` and `/logout` slash commands inside a session are unchanged.

New:

- `namzu auth status [--json]` lists each stored or detected credential (provider, where it comes from, kind, usable or expired) and exits 0 when one is usable, 1 when none is. It never prints a token, key or any part of one.
- `namzu state purge [path] [--dry-run] [--yes] [--all]` deletes what Namzu keeps in its home for one project (conversations, checkpoints, file history, plans, memory, backups, prompt-history lines, index rows) or for all of them, and never touches files in the project folder. It asks first, needs `--yes` with no terminal, and refuses a project with a running session or leftover Namzu worktrees.
