---
"@namzu/cli": patch
---

Conversation search now advances through fully searched, nonmatching indexed runs in the same call instead of requiring a model round trip for each irrelevant run. It keeps the shared 8 MiB read ceiling, bounded directory discovery, source ownership checks and existing result limits. Partial index pages and matching pages still return control with a continuation when needed; unavailable evidence remains explicitly incomplete.

The read tool now asks the model to copy the search result's exact byte position, and gives actionable recovery guidance when an estimated position splits a UTF-8 character. It continues to refuse invalid reads rather than silently adjusting the requested position.
