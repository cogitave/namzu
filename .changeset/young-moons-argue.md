---
'@namzu/cli': minor
---

`Ctrl+O` expands collapsed tool output in place again, for the rows still on
screen.

The last few transcript entries are now drawn live rather than printed once, so
pressing `Ctrl+O` replaces the `… +6 lines` hint with the lines it was hiding —
in the row where it already is, with nothing printed twice. Pressing it again
closes them.

How far back it reaches is bounded by your terminal's height, because the live
region has to stay well inside the viewport. On a terminal roughly under thirty
rows there is no room for one, and `Ctrl+O` says so and points at `/expand`
rather than doing nothing. `/expand <n>` is unchanged and remains the way to
reach anything older; it still appends the full body as a new entry.

Nothing changes for a caller: no exported type, flag or route moved.
