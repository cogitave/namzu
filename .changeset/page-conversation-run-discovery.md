---
"@namzu/cli": patch
---

Fix conversation evidence searches that permanently excluded runs after the
first 100 directory entries. `search_conversation` now returns a continuation
for later discovery batches, including empty batches containing no run IDs.
`read_conversation` and automatic recall keep their existing exact-text,
ownership, byte and page limits; no tool action is replayed.

Discovery resources are bounded to 32 scans and 128 cached name pages per
process and expire after ten minutes. Concurrent reads of one continuation
share its page. Directory changes require restarting discovery, and CLI
Session shutdown closes abandoned scans. Batch order is not chronological
or globally ranked; automatic recall remains opt-in and non-exhaustive.
