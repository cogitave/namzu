---
"@namzu/cli": patch
---

A conversation you resume (`namzu -c`, `namzu resume <id>`, `/resume`) now shows the work it did, not only the prompts and replies. Reads, edits, writes, commands and failed calls come back as the same rows you saw while it ran, with their diffs and command output behind Ctrl+O. Long turns end with their `Worked for` line again, a turn you stopped says `Interrupted.`, and the agents it launched show their launch and result rows. Nothing to change on your side; a conversation saved without a journal (a fork, an older log) shows the calls but not their timings.
