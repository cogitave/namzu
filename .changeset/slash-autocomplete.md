---
'@namzu/cli': minor
---

**Slash-command autocomplete in the composer.**

Typing `/` now opens a dropdown of matching commands (name + description) below the input, the way claude-code and gemini-cli do. Navigate with ↑/↓, press Tab to complete the highlighted command (ready for arguments), or Enter to run it. The dropdown closes once you type a space (moving on to arguments) or anything that isn't a command name; ↑/↓ fall back to input history when it's closed.
