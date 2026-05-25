---
'@namzu/cli': minor
---

**See your namzu sessions across terminals with `/agents`.**

When the daemon is running (`namzu serve`), each namzu window registers its presence with it and heartbeats its state. The new `/agents` slash command lists every namzu session running across your terminals — a state dot, its title/folder, current state, and how long ago it was active (marking the current one). Presence is best-effort: without a daemon, namzu behaves exactly as before. (Attaching to / switching into another terminal's session is the next step.)
