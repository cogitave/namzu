---
"@namzu/cli": major
---

The interactive terminal UI now starts fullscreen with the pointer on, where it used to start on the terminal's own scrollback screen with the pointer off. What changes for you: the app takes the alternate screen and the wheel, drags and clicks go to Namzu instead of the terminal (hold your terminal's bypass key, usually Shift, to use its own selection), the conversation is no longer left in the terminal's scrollback after you exit, and the `←` key that opens the workspaces screen from a session opens the agents cockpit instead. To keep the old behaviour, set `NAMZU_FULLSCREEN=0` in the environment or `"tui": { "fullscreen": false }` in your own config; `tui.mouse: "scroll"` or `"off"` (or `NAMZU_DISABLE_MOUSE_CLICKS` / `NAMZU_DISABLE_MOUSE`) keeps the terminal's selection while staying fullscreen. `NAMZU_FULLSCREEN=1` and `tui.fullscreen: true` still force it on.

Along with the default, in fullscreen:

- A short conversation starts under the header with the prompt pinned at the bottom, instead of the header being drawn above the prompt with a blank screen over it.
- A click on a permission prompt's answer chooses it, as the digit on it does; the mode, effort and model items of the footer answer a click (the mode cycles, the other two open `/effort` and `/model`).
- Motion with no button down is reported, and the link, tool row, permission answer or footer item under the pointer lights. The screen is redrawn only when the pointer enters a different target.
- A web address, or a `path:line` of a file inside the project, in a reply or a tool's output opens on `ctrl`-click or `alt`-click (the browser opener, or `$VISUAL`, `$EDITOR`, then `code`, `cursor` or `zed` with a line flag); a plain click says how, and when nothing can be started the address or path is shown to copy. Where the terminal takes them, link text is also sent as an OSC 8 hyperlink.
- `ctrl+o` draws the whole conversation in the scrolling window: the wheel scrolls it, a drag selects and copies, a click on a tool row folds it, `/` searches with `n` and `N`, `v` opens it in the editor, a header lists the keys, and each reply carries when and by which model it was written. On the scrollback screen a conversation of up to 200 rows is now shown whole instead of its last 30.
- What a copy or a link answers appears in the footer's right end for a moment and no longer draws over the last row of the conversation.

`PointerReport` (internal) gains a `move` kind and `ctrl`, `alt` and `shift` flags; nothing exported from the package changes.
