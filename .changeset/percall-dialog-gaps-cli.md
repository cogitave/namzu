---
'@namzu/cli': minor
---

A prompt to write a file, whether the file is new or replaced, now offers "Yes, and switch to accept edits for this session" and Shift+Tab answers it, as it already did for an edit. Accept edits mode now runs a file write inside your folders without asking; a path outside them, a protected file and a rule that asks still ask, and a write too long to show in full stays a one-time yes. If you relied on being asked for every write in Accept edits mode, stay in the default mode. The "Not run: an earlier call was declined and the turn stopped." row no longer says "(ctrl+o to expand)", because nothing is hidden behind it.
