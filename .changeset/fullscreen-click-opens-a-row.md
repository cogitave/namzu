---
'@namzu/cli': minor
---

In fullscreen mode (`tui.fullscreen: true` or `NAMZU_FULLSCREEN=1`) you can now click a folded row to open it where it stands, and click it again to fold it. This works on a counted line (`Read 3 files, ran 2 commands`) and the commands listed under it, on a tool or command output that is cut (`… +30 lines`), and on a collapsed agent answer. The hint on those rows reads `(click to expand)` instead of `(ctrl+o to expand)`, and an open row says `(click to fold)`. The row you click stays where it is on the screen; if opening it pushes the newest output off, the view stops following and `↓ Jump to latest` brings you back. Dragging to select still copies, and a click that finds a selection only clears it.

It needs the pointer reported in full, which is the default: with `tui.mouse: scroll` or `off`, in the normal screen and in the scroll-back nothing changes and the hint stays `(ctrl+o to expand)`. Which rows are open is not saved, so a resumed conversation starts folded. Links in replies are still plain text; Namzu does not open them.
