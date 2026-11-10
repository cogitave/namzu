---
'@namzu/cli': minor
---

Fullscreen mode (opt-in with `tui.fullscreen` or `NAMZU_FULLSCREEN=1`; nothing changes when it is off) draws replies as rendered Markdown, lets you select and copy text, and searches the conversation.

A drag selects text in the window (double click a word, triple click a line); on release the plain text is copied to the clipboard, as `/copy` does, without styling, gutter glyphs or the line breaks a wrap added. Esc lets go. `tui.copyOnSelect: false` keeps the selection and copies on ctrl+c. Alt+S opens a search line: matches are highlighted as you type, Enter and Shift+Enter move between them, and Esc returns to where you were. In this mode the terminal is now asked for drags as well as the wheel, which turns off the terminal's own selection inside the app; set `tui.mouse: scroll` or `off` (or `NAMZU_DISABLE_MOUSE_CLICKS=1`) to keep it.
