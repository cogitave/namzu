---
'@namzu/cli': minor
---

`namzu <area> <action> --help` (and `namzu help <area> <action>`) now prints that action's own help: its usage line, what it does, its options and an example. Before, it printed the whole area's help. `namzu <area> --help` ends with one line per action and says `namzu <area> <action> --help for details.` Covers schedule (and schedule service), extension, browser, mcp, auth, state, computer, config, skills, providers, worktree, pal, peers, plugin, github and archive. Nothing a command accepts or prints other than help changes. `CommandDef` gains an optional `actions` table.
