---
'@namzu/cli': patch
---

No change for anyone using the terminal app. Internal: the rules that decide when the next model round starts (queued messages, goal rounds, wake notices) move out of the screen component into their own module, so they can be run without a screen. Nothing exported changes and no setting or command differs.
