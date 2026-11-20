---
'@namzu/cli': patch
---

The keypad Enter sends a message, and the other keypad keys type or move as their main keys do, when the terminal sends them in application keypad mode (`ESC O M` for Enter, `ESC O p` to `ESC O y` for the digits). Before, the keypad Enter did nothing in a terminal left in that mode by another program or a multiplexer. Nothing changes for terminals that send the main key's byte or the keyboard protocol's own codes.
