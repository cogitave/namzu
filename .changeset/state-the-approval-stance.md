---
'@namzu/cli': patch
---

A session running under `strict`, `auto` or an unattended mode now tells the model, in the notice that announces the mode, that a refused call is not followed by a question, so it picks another route or reports what was blocked instead of asking for approval nobody will give. The notice goes out on the first request of a session that starts in the mode and whenever it is switched on; the system prompt states no mode, so a mode switch does not change the cached prefix and leaves no stale sentence. No setting changes.
