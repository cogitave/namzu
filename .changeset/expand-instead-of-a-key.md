---
'@namzu/cli': major
---

**`/expand` reads a collapsed tool output in full. `Ctrl+O` is deprecated and
stops expanding anything.**

Tool diffs and command output collapse to six lines. The hint under them now
names the command that reopens them — `… +6 lines · /expand 3` — and `/expand`
with no argument takes the most recent one. The full text arrives as a new entry
below, so the collapsed one stays where it was.

## What breaks

**1. `Ctrl+O` no longer expands anything.** It is still bound: pressing it prints
the reason and points at `/expand`, so nobody meets a dead key.

Be clear about what it did, because it was not nothing. It was advertised as
toggling full expansion for everything, and for output already on screen it was
inert — finalized entries are printed once to the terminal's own scrollback and
never redrawn, which is what keeps a long session bounded and native scrolling
and selection working across the whole conversation. But pressing it *before* a
tool finished did have an effect: the result, when it arrived, printed in full.
That behaviour is removed. It required deciding you wanted the output before you
could see that it had been truncated, and nothing on screen ever mentioned it.

*To keep the old behaviour:* there is no flag for it. Run the tool, then
`/expand`, which reaches output the key never could.

**2. `expand` is now a reserved command name.** If you have a user-defined
command at `~/.namzu/commands/expand.md` or `./.namzu/commands/expand.md`, the
built-in takes the name and yours stops running — in the TUI and in `namzu run`
/ `run-stream` alike. Rename the file, and `/help` will report it as shadowed
until you do.

## Also in this change

- The collapse hint carries a number, and only bodies that actually truncate get
  one. A body short enough to print whole advertises nothing and takes no number.
- The blank-row estimate that decides where the composer sits now counts the
  collapsed body under a tool call, the blank row between entries, and the width
  the body really renders at. It previously measured each entry by its first line
  alone, so a six-line tool result counted as nothing — in the direction that
  pushes the composer off the bottom of the screen.
