---
'@namzu/cli': patch
---

A very long reply in the fullscreen view (`tui.fullscreen`) takes far less memory and processor time while it streams, and nothing changes on the screen. Every row is still there to scroll back to, search and select, and a copy still holds the whole text. The view now lays out only what a new piece brought instead of the whole reply again, and keeps one copy of each row. There is nothing to switch on or off. The default screen is untouched.
