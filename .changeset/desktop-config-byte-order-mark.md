---
"@namzu/desktop": patch
---

A folder whose `namzu.config.json` was saved with a leading byte-order mark (Windows editors add one) is checked for commands that run on their own like any other, instead of being reported as unreadable.
