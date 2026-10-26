---
'@namzu/cli': minor
---

Add themes and a reduced-motion setting to the terminal UI. The default is unchanged: `dark` is the look Namzu has always had, so nothing changes unless you ask.

- `/theme` opens a list of seven choices (auto, dark, light, and a colorblind-friendly and an ANSI-only version of each) with a live preview as you move; Enter saves, Esc puts the saved theme back. `/theme <name>` applies one directly. `auto` follows the terminal's light or dark background.
- `/config theme [name]` does the same as `/theme`. Rows already on screen are redrawn in the new theme, and every new surface (the detailed transcript, the rewind dialog, tips and notices) draws through the theme colours.
- New config keys `tui.theme` and `tui.reducedMotion` in your user config. A project file cannot set them and its values are ignored, so a repository cannot restyle your terminal.
- `tui.reducedMotion: true` (or `/config motion on`) stops the working line's moving highlight, the composer's pulse, the open read/search line's blinking dot and the tab title's busy glyph.
