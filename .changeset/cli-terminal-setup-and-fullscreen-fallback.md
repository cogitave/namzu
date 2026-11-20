---
'@namzu/cli': minor
---

New `/terminal-setup` command and a fullscreen fallback.

`/terminal-setup` makes Shift+Enter start a new line in VS Code, Cursor, Windsurf, Zed and Alacritty (and Option+Enter in Terminal.app). It copies every file it changes to `<file>.<8 hex>.bak` first, says what it changed, and only runs when you type it; a tip suggests it in those terminals until it has been done. In a remote editor session, or when a file cannot be read, it prints the exact lines to add by hand and changes nothing.

If fullscreen fails to start (the screen is not drawn, or the process ends within 10 seconds of starting without a clean exit), the next launch on that machine uses the normal screen and says so; after two failed starts in a row fullscreen stays off on that machine until the next Namzu version. Run `/tui fullscreen` to try again, or `/tui default` to keep the normal screen; both save `tui.fullscreen` and take effect on the next start. A launch that stays healthy resets the count, and `tui.fullscreen: true` in your config is never overridden by it. `/tui` saves the setting but does not restart Namzu; restart it yourself. `NAMZU_FULLSCREEN=1` or `=0` still decides the screen by itself and is never overridden. Namzu now keeps `~/.namzu/terminal-state.json` for this.
