---
'@namzu/sdk': patch
---

Calling a deferred tool before its schema is loaded now returns `Tool "<name>" is not loaded yet. Call search_tools with its exact name, then call it again.` where it returned `Tool "<name>" is deferred and cannot be executed`. A host that matched the old text should match on the tool being deferred instead; nothing else changes.
