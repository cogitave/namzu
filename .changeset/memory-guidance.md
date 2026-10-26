---
'@namzu/cli': patch
'@namzu/sdk': patch
---

The model now keeps memory itself during a session. When the memory tools are mounted, the system prompt carries a short `## Memory` section saying what is worth saving (the person's preferences and corrections, decisions and their reasons, lessons from failures, pointers to outside resources), what to leave out, and how to keep the store tidy (one fact per memory, update instead of duplicating, remove a wrong one, check a recalled memory against the current code). The section sits in the stable prefix, so it does not change prompt caching. The descriptions of `save_memory`, `search_memory`, `read_memory`, `update_memory` and `delete_memory` now state purpose, when to use the tool and what it returns, and the stored-memory index paragraph no longer repeats those rules. No option, export or tool input changes; nothing to do on upgrade.
