---
"@namzu/cli": patch
---

Typing that reaches the composer in one long read (keystrokes queued behind a busy screen, with no bracketed-paste markers) is now inserted as typed text. It used to become a `Pasted text` chip once it passed 80 characters, and the chip was joined back to what had been typed before it with a blank line — so the message the model received could have a word split in two ("subag" / "ents"). A bracketed paste over 80 characters, and any unbracketed chunk containing a newline, is still held as a chip. Nothing to do on upgrade.
