---
type: Reference
title: namzu state purge
description: Delete everything Namzu keeps in its own home for one project, or for every project, without touching the project folder; what it lists, what it refuses and how it asks.
resource: packages/cli/src/integrations/state/purge.ts
tags: [cli, state, storage, privacy]
status: stable
generated: { by: process:agent, at: 2026-11-23T00:00:00Z }
---

# namzu state purge

```text
namzu state purge [path] [--dry-run] [--yes] [--all]
```

Deletes the local state Namzu keeps **for** one project: the project of the current
folder, or of `[path]`. It never deletes a file in the project folder itself, so
`.namzu/settings.json`, `.namzu/settings.local.json` and anything else there stays.

What goes, all under the Namzu home (`~/.namzu`, or `NAMZU_HOME`; see
[Session storage](session-storage.md)):

- `projects/<slug>/`: conversations, checkpoints, file history, plans, memory, learning
  and the project record;
- `backups/projects/<slug>/`: recovery copies of the project's settings file;
- `legacy/<slug>/`, `memory-inbox/<slug>.jsonl` and `memory-usage/<slug>.json`;
- the project's lines in `history.jsonl`, the prompt history (other projects' lines stay);
- the project's rows in the session index `index.sqlite`.

Trusted-folder entries, scheduled jobs for the folder and the temporary scratch folder
are not state kept for the project and are left alone.

## Asking first

Without `--yes` it lists what it will delete and asks `Delete this? [y/N]` on a terminal.
With no terminal and no `--yes` it deletes nothing, prints one line and exits 64.
`--dry-run` lists and deletes nothing, and never asks. `--all` purges every project and
every line of the prompt history under the same rules; it takes no path.

## What it refuses

- It stops for a project while a session of it holds its lease, naming the process, and
  while git worktrees Namzu made for it are still in its folder (remove them with
  `namzu worktree` first). With `--all` such a project is skipped, the others are purged,
  the prompt history is left as it is, and the exit status is 1.
- Every path is checked before it is measured and again before it is deleted. A path
  that is a link, or whose parent resolves outside the real Namzu home, is left alone and
  reported; nothing outside the Namzu home is ever deleted.

The exit status is 0 when everything listed was deleted (or nothing was kept), 1 when
something was left alone or could not be deleted, and 64 for a usage error.
