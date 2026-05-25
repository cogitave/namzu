---
'@namzu/cli': minor
---

**Attach to a session running in another terminal.**

With the daemon running (`namzu serve`), you can now drive a daemon-hosted session from the TUI:

- `/dispatch <task>` creates a hosted session, hands it the task, and attaches — you watch it work live.
- `/attach <id>` attaches to an existing hosted session (ids come from `/agents`, which now lists hosted sessions too).
- While attached, what you type goes to that session; its events stream into your transcript exactly as a local turn would render (the renderer is shared).
- `/detach` returns you to your local session.

This is real cross-terminal switching: the session lives in the daemon, so any terminal can attach to and continue it.
