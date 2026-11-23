---
'@namzu/cli': patch
---

In the fullscreen view, `ctrl+c` while text is selected no longer interrupts the running reply. It copies the selection, or lets go of one that was already copied when you released the mouse; with nothing selected `ctrl+c` interrupts as before.
