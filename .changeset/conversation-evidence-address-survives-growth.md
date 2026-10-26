---
"@namzu/sdk": patch
"@namzu/cli": patch
---

An evidence address or cursor from a session log no longer stops working as soon as the log grows. The seal used to include the log file's size and times, so every tool call of a running conversation voided the address a search had just returned, and `read_conversation` after `search_conversation`, or a second page by `nextCursor`, answered "could not be read". The seal now binds the file's identity, and the read still checks the record's offset, length and digest. A log that was rewritten or replaced is still refused. Nothing to do on upgrade.
