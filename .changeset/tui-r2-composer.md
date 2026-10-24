---
'@namzu/cli': patch
---

The terminal message box now shows a pasted block as a short label inside your text, for example `[Pasted text #1 +40 lines]`, and a pasted image as `[Image #1]`, instead of a separate row above the box. Backspace removes a label whole, and the full text is sent when you press Enter. Pastes of up to a few lines now stay as ordinary text. On a fresh conversation the empty box suggests an example such as `Try "fix lint errors"` (naming a file you edit often when it can), and the hint for queued messages now adds that Enter sends them now, shown for its first three appearances. Nothing to change on your side.
