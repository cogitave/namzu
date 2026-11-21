---
"@namzu/cli": patch
---

The old-conversation sweep no longer removes a conversation that a scheduled job delivers its results to (or has results queued for), so a monthly job keeps reaching the conversation that made it. The seven-day notice period now starts when the notice is shown on screen, not when it is written. Prompt history trims by time, and conversations the desktop app started are no longer copied into it.
