---
'@namzu/cli': patch
---

In the fullscreen view, `ctrl+shift+c` copies the selected text and never interrupts the reply, also in terminals that report it in xterm's `modifyOtherKeys` form (which used to be typed into the message box as text). With nothing selected it does nothing. A terminal that sends it as a plain `ctrl+c` byte still gives `ctrl+c`.
