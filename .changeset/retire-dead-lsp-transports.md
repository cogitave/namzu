---
'@namzu/lsp': patch
---

Reject in-flight and future navigation calls immediately when a language
server's stdio transport closes after startup, while retaining ownership of
the child process for bounded disposal.
