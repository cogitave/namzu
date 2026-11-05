---
'@namzu/cli': minor
---

The terminal session now plays a short chime when it needs you back: a soft rising pair of notes when a turn that ran for ten seconds or more finishes, and a double tap when a turn stops, fails or waits for your approval. A shorter finished turn stays silent. It is on by default and plays where Namzu runs, so it is silent over SSH; it uses PowerShell on Windows and WSL, `afplay` on macOS and `paplay`, `pw-play` or `aplay` on Linux, and does nothing when none exists. To keep the old silence, set `tui.sound: false` in your config or `NAMZU_NO_SOUND=1` in the environment.
