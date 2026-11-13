---
'@namzu/cli': patch
---

When you leave, the `session_end` hook of a conversation you left behind with `/clear` or `/new` now finishes before the `session_end` hook of the last conversation starts. They used to run at the same time, so two hooks that append to one file could mix their lines and a script could see the ends out of order. Leaving takes no longer than the two deadlines one after the other (five seconds each unless an entry names its own).
