---
'@namzu/cli': minor
---

Add themes and a reduced-motion setting to the terminal UI. The default is unchanged: `dark` is the look Namzu has always had, so nothing changes unless you ask.

- `/theme` opens a list of seven choices (auto, dark, light, and a colorblind-friendly and an ANSI-only version of each) with a live preview as you move; Enter saves, Esc puts the saved theme back. `/theme <name>` applies one directly. `auto` follows the terminal's light or dark background.
- New config keys `tui.theme` and `tui.reducedMotion` in your user config. A project file cannot set them and its values are ignored, so a repository cannot restyle your terminal.
- `tui.reducedMotion: true` (or `/config motion on`) stops the working line's moving highlight and the composer's pulse.
- The `tui` config block now merges key by key across your config files, so a later file that sets only `notifications` no longer drops an earlier file's `notificationMethod`. If you relied on a later file replacing the whole block, list every key you want in that file.
