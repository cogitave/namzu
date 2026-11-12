---
'@namzu/cli': minor
---

The terminal UI's default screen now writes only what changed, and no longer wipes your terminal.

- **Starting keeps what was on your screen.** The banner and the first frame are drawn under the shell's last line. Before, starting cleared the visible screen and the whole scrollback.
- **A resize no longer clears your scrollback or prints the conversation again.** Rows already printed stay as your terminal reflowed them; only the live region at the bottom is erased and drawn again, once, at the new width after the window has stopped changing. Before, a resize cleared the scrollback and printed the whole conversation up to three times, and the first frame showed rows wrapped at the old width.
- **Far less is written while a reply streams.** Only the changed rows, and inside a row the changed cells, are written, at most twelve times a second, and nothing when nothing changed: about 18 KB per ten seconds of a streaming reply instead of 244 KB, and the bottom of the screen no longer flickers on a terminal that does not support synchronized output.
- **Leaving gives the terminal back.** The cursor is shown on a clean line after Ctrl+C, a signal, an uncaught error, and a stop and continue.

Nothing else about what is drawn changes. Fullscreen (`tui.fullscreen`) is unchanged. If your terminal shows something wrong, `NAMZU_LEGACY_PAINT=1` returns to the previous writer (the whole live region every frame, and a cleared scrollback on resize); please report it.
