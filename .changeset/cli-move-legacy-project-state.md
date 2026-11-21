---
'@namzu/cli': minor
---

`namzu state` now names the state an earlier Namzu kept inside a project's own
`.namzu` folder (`cli.json`, `projects/`, `sessions/`, `checkpoints/`,
`worktrees/` and the rest) as `legacy`, where it used to count `cli.json` and
`projects/` as current runtime state and miss `projects/prj_*` entirely; the
memory curation log in the Namzu home is no longer called legacy. The new
`namzu state move legacy` moves that state into `~/.namzu/legacy/<folder>/<time>/`
when you ask (`--dry-run` lists what would move): only in a folder you trust,
only names an earlier Namzu wrote, never what git tracks or a git worktree with
changes, and a copy across disks is compared with the original before the
original is removed. Until you move it, a session in a trusted git checkout
adds one block to the clone's `info/exclude` so git does not list it, and says
so once. Nothing to do unless you want the old files out of the folder.
