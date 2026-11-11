---
"@namzu/cli": patch
---

A conversation no longer refuses every message after the app was closed in the first instant of a reply. When a host went away after writing only a reply's start and your message, the next host treated that reply as still running and the Desktop answered "Namzu is still finishing the last reply. Give it a moment." to everything you sent. The host now closes a reply that has no host running it, with one record and your message kept, when it is asked whether the conversation can go on, and a message sent to a host that never asked closes it as well. A reply another host still holds, and a paused one, are left alone.
