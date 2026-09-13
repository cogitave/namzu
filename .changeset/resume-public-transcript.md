---
"@namzu/cli": patch
---

Resumed conversations and earlier-prompt forks no longer show blank assistant
rows for tool-only messages. Retained public commentary and final-answer items
are restored as separate entries when they still match the saved answer. Edited
or compacted content takes precedence over stale parts. Tool results and provider
replay state remain unchanged for the next model request.
