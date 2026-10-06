---
"@namzu/cli": patch
---

Mark unfinished Claude messages closed by native failure or interruption as cancelled instead of completed replies. Preserve partial text, the failed turn's actual status and error, and messages the engine already completed.
