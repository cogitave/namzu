---
'@namzu/cli': minor
---

The terminal now reports whether its window has focus, and Namzu uses it in two ways. The tab title's busy glyph alternates between two frames every 960 ms while a reply is working and the window has focus (it stays on the idle glyph during a permission wait and inside tmux, screen or zellij). And when you leave the window and a finished reply has sat for three minutes, Namzu writes a one-line recap of where things stand, shown as a `※ recap:` row when you come back.

The recap costs one small-model request each time (at most 120 reply tokens, from a digest of at most 6,000 characters of your recent prompts and replies; it needs at least three typed prompts in the conversation and two since the last recap). It is on by default. To switch it off, set `tui.recap: false`, run `/config recap off`, or set `NAMZU_RECAP=0`; `NAMZU_RECAP=1` forces it on. `/recap` writes one on request. A terminal that never reports focus never gets a recap. Runs without a screen (`exec`, `--json`) never recap.
