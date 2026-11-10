---
'@namzu/cli': minor
---

New opt-in fullscreen screen for the interactive terminal UI. Set `tui.fullscreen: true` in your own config, or start with `NAMZU_FULLSCREEN=1`, and Namzu draws on the alternate screen: the conversation is a window the app scrolls itself (mouse wheel, PgUp and PgDn, Home and End on an empty composer), the composer and footer stay on the bottom rows, a quiet row says how to jump back to the latest, and only the lines that changed are repainted. `NAMZU_FULLSCREEN=0` turns it off whatever the config says. Nothing changes unless you opt in: the default is still the terminal's own scrollback, byte for byte. While it is on, the `←` workspaces screen is not offered, and the terminal's own scrollback and drag-to-select are not available inside the app; the screen shows replies as plain wrapped text rather than rendered Markdown.
