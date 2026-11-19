---
'@namzu/desktop': patch
---

Clearing the default permission mode in Settings no longer shows the risky-mode warning, since clearing puts it back to the safe default. Settings whose default is itself the risky choice (web search live, for example) still ask before a clear.
