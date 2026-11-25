---
"@namzu/cli": patch
---

A typed skill command whose commands loaded but whose line was then queued or blocked no longer leaves the skill's own hooks attached for the rest of the conversation. A value placed in a shell comment or after a backslash in a skill's command now refuses the load instead of being quoted wrongly.
