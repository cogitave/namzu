---
'@namzu/sdk': patch
---

The "Working commands" section a compaction carries no longer keeps a command that may hold a credential (an inline `VAR=value`, an auth header, a token flag, a URL with a password or token), and only a command whose first word in a segment is a runner is kept. Nothing to change.
