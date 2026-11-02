---
"@namzu/cli": patch
---

An agent that is still running is now listed once. Before, the model also saw a second, "unresolved" record of the same job under its session ID and could tell you there was a stray unfinished copy. The saved-agents view and the note about earlier agents now leave out any agent that is running; "unresolved" still marks an agent with no recorded ending that is not running, for example after a crash or restart.
