---
type: Reference
title: Themes and reduced motion
description: The terminal UI's seven theme choices (auto, dark, light, colorblind-friendly and ANSI-only versions of each), how auto decides, the /theme picker with its live preview, the tui.theme and tui.reducedMotion config keys, and what reduced motion switches off.
resource: packages/cli/src/tui/theme-palettes.ts
tags: [cli, tui, theme, accessibility, config]
status: stable
generated: { by: process:agent, at: 2026-10-25T00:00:00Z }
---

# Themes and reduced motion

The terminal UI draws in one of six themes. `dark` is the default and is the look Namzu has always had: phosphor green on the terminal's own background. Namzu paints no background of its own in any theme; a theme only colours text and the diff rows.

| Setting | Row in `/theme` | What it is |
|---|---|---|
| `auto` | Auto (match terminal) | `dark` or `light`, whichever the terminal's background is |
| `dark` | Dark mode | The default |
| `light` | Light mode | The same hues pulled darker so they read on a pale background |
| `dark-daltonized` | Dark mode (colorblind-friendly) | Success, added and the accent move from green to blue; errors and removed stay red |
| `light-daltonized` | Light mode (colorblind-friendly) | The same, for a light terminal |
| `dark-ansi` | Dark mode (ANSI colors only) | Only the terminal's own sixteen named colours, so the terminal's colour scheme decides every shade |
| `light-ansi` | Light mode (ANSI colors only) | The same, for a light terminal |

The palettes are data in `packages/cli/src/tui/theme-palettes.ts`. The live `theme` object the components read is `theme.ts`; `theme-store.ts` decides which palette fills it.

## Choosing

`/theme` opens a list of the seven rows. The saved one is marked `[current]` and is highlighted first. Moving the highlight recolours the screen at once (a preview); `Enter` saves and says `Theme set to Light mode.`, `Esc` puts the saved theme back. Under the list a small sample shows an added and a removed row and the success, failure and warning colours (it is left out on a terminal shorter than 26 rows). `/theme <name>` applies and saves a name directly (`/theme light-daltonized`); an unknown name prints the usage line. `/config` lists a `Theme` row that opens the same picker, and `/config theme [name]` does what `/theme [name]` does. A row already on screen is redrawn in the new theme, its mark included; every surface (the detailed transcript with its thinking text, divider and footer, the rewind dialog, the tip row and the notices) is drawn from the theme colours, so the light, colorblind-friendly and ANSI-only themes apply to all of them.

Saving a theme reprints the transcript once, the way a resize does, so what is already on screen follows the new colours. A line that was written with a colour of its own (a few status glyphs) keeps the colour it was written in.

The choice is written to `tui.theme` in your user config (`$NAMZU_HOME/config.yaml`), keeping the rest of the file. A file that cannot be written still changes the theme until Namzu closes, and the reply says so.

## How `auto` decides

1. At start, only when the setting is `auto` and Namzu is attached to a terminal, Namzu asks the terminal for its background colour (the terminal answers on standard input). A reply is read as `rgb:RRRR/GGGG/BBBB` (one to four hex digits per channel) or `#rrggbb`; a luminance of `0.2126 R + 0.7152 G + 0.0722 B` above 0.5 is light. The terminal has 250 ms to answer.
2. With no answer, `COLORFGBG` (the text after its last `;`, a number from 0 to 15): 0 to 6 and 8 are dark, the rest light.
3. With neither, dark.

`auto` is decided once at start. Picking `auto` from `/theme` in a running session uses `COLORFGBG` (or the answer from this start); the terminal is asked again at the next start, and a change of the terminal's own theme is not followed meanwhile.

## Config

```yaml
tui:
  theme: auto            # auto | dark | light | dark-daltonized | light-daltonized | dark-ansi | light-ansi
  reducedMotion: false
```

Both keys are read from your own files (user config, a profile you select, the managed file). A project file's `tui.theme` and `tui.reducedMotion` are ignored: a repository must not restyle your terminal. The project file's other `tui` keys (notifications) still apply, and the layers merge key by key.

## Reduced motion

`tui.reducedMotion: true`, or `/config motion on` (also the `Reduce motion` row in `/config`), turns off decoration that moves:

- the working line's highlight sweep and its slow shift toward red when the model goes quiet: the words stay, in one plain colour;
- the pulse along the composer's rule when hypermode is switched on (it plays once when `/hypermode` turns the session mode on, not when the word is merely typed into a message);
- the blinking dot of an open line of reads and searches, which stays lit;
- the tab title's busy glyph, which stays on its first frame.

Text, colours otherwise, and every figure (elapsed time, token count) are unchanged. Default off. `NO_COLOR`, `FORCE_COLOR=0`, `TERM=dumb` and a screen reader also stop the motion, with or without the setting. `/config motion` says which it is now.

## First run

Namzu has no first-run welcome flow, so there is no theme question there: the default is `dark`, and `/theme` is the way to change it.
