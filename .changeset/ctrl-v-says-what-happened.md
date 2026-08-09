---
'@namzu/cli': patch
---

Ctrl+V says what happened when there is no image to paste

The status bar advertises `Ctrl+V to attach`. Pressing it read the clipboard,
attached an image if it found one, and otherwise did nothing at all — no chip,
no message, no error.

So three quite different situations produced one identical silence: you have not
copied an image; this machine has no clipboard tool installed; the key was never
wired up. The operator's next move differs in each — copy an image, install a
tool, or stop pressing the key — and the screen gave them nothing to choose
with.

Each outcome now says which it was, and a missing tool names what to install
(`xclip` on X11, `wl-clipboard` on Wayland). The success path stays quiet,
because the attachment chip is already the report.

The reason had to be recovered before it could be shown: the clipboard reader
returned a bare `null` for every failure, and on Linux a missing `xclip` and an
empty clipboard are indistinguishable after the fact — both come back from the
shell as a non-zero exit. It now checks whether any reader exists before
attempting the read, and returns which of the two it found.
