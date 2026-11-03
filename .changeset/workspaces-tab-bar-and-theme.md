---
"@namzu/cli": minor
---

The workspaces screen has a new two-row tab bar and takes its colours from your Namzu theme.

- The tab bar is two rows: tabs on the first, a thin rule on the second with the active tab's span drawn heavy. Panes start one row lower, so each session's terminal is one row shorter than before; nothing needs doing, a session redraws to fit.
- Tabs that do not fit no longer disappear. The active tab stays in view (a very long name is cut with `…`), `‹` and `›` mark tabs out of sight and can be clicked, and the `+` stays at the far end. Before, a long active tab emptied the bar.
- The mode hints (`PREFIX`, `NAVIGATE`, `RESIZE`) and notices are drawn at the right end of the rule row instead of over the bottom row of the panes, which stay readable while a mode is on. A session shown full screen has no tab bar, so these still take its last row.
- Split panes have rounded corners and one empty cell between neighbours instead of two border lines side by side; a border is dragged by that gap or either edge. A split needs one more column or row than before.
- Colours follow `tui.theme` (dark, light, the colour-blind variants, ANSI, `auto`) instead of a fixed blue palette, and use the same truecolor detection as the conversation screen, so terminals such as Windows Terminal that were drawn in 16 colours now get full colour. `NO_COLOR`, `FORCE_COLOR=0` and `TERM=dumb` draw no colour: the active tab and the picked row are reversed. State dots differ by shape (`●` working, `○` idle, `◆` needs approval, `✓` finished) as well as colour.

If a script reads the workspaces screen's cells or the size of a pane's terminal, expect the shifted rows and the new glyphs. No settings or flags change.
