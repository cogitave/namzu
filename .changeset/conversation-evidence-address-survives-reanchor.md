---
"@namzu/sdk": patch
"@namzu/cli": patch
---

A conversation search address or cursor now stays valid when the next tool call reads it, even though that call is anchored at a later record. Previously every `read_conversation` after a `search_conversation` in a running turn was refused as changed. A seq past the end of the conversation is also answered at once on the live backend, naming the highest retained seq. Nothing to change in callers.
