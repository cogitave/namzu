---
'@namzu/cli': patch
---

**Cleaner tool output in the transcript.**

Tool results that come back as JSON (clawtool / MCP tools) no longer render as a raw one-line blob: a `{ output | result | content | text }` envelope is unwrapped to just its payload, and any other JSON is pretty-printed. The one-line `⎿` summary is derived the same way (the payload's first line, an error message, or a short key list) instead of a truncated JSON string — so a tool call reads at a glance.
