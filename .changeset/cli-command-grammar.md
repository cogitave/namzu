---
'@namzu/cli': major
---

Commands follow one grammar: words separated by spaces, no second names. Four spellings are retired. Each now prints one line naming the new spelling and exits 64 without doing anything:

- `namzu spaces` is `namzu workspaces`. The `tui.spacesPrefix` setting is still read.
- `namzu e "<prompt>"` is `namzu exec "<prompt>"`.
- `namzu config reset <key>` is `namzu config unset <key>`.
- `--yolo` (on `namzu`, `namzu resume`, `namzu exec` and `namzu drain`) is `--dangerously-skip-permissions`. Scripts that pass `--yolo` must be changed; it no longer runs.

`namzu computer stop-idle` is now `namzu computer stop idle`. The old spelling is what Namzu Desktop builds already installed run, so it keeps working and is hidden from the help; change your own scripts to `stop idle`.

New: `namzu help [command] [action...]` prints exactly what `namzu <command> [action...] --help` prints. `--help`, `-h`, `--version`, `-V` and `help` now work when `NAMZU_HOME` names a folder that does not exist (`namzu <command> --help` used to exit 70) and never create it. Every usage line starts with `namzu` (`namzu eval` did not), and `namzu serve` now says what it does.
