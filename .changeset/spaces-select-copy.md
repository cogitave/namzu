---
"@namzu/cli": minor
---

Spaces: drag to select text in a pane and it is copied when you let go (double-click picks a word, triple-click a line). New settings `tui.mouse` (`full`, `scroll` or `off`) and `tui.copyOnSelect`, and the environment variables `NAMZU_DISABLE_MOUSE` and `NAMZU_DISABLE_MOUSE_CLICKS`, let you capture less of the mouse or keep your terminal's own selection. Nothing breaks and no default changes for a plain `namzu` conversation, which never captures the mouse. `/copy` and a pane's own copy request now reach your terminal from inside spaces, and `/copy` works under tmux and screen. The mouse is switched off on `SIGTERM`, `SIGHUP` and `SIGINT`, and every interactive launch clears a mouse a killed run left on; no action needed.
