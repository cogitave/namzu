---
"@namzu/sdk": minor
"@namzu/cli": patch
---

A long session costs less each turn: taking a session's log for writing no longer parses every record it already verified. Nothing is trusted that was not checked: the first claim of a log in a process verifies it in full as before, and every later claim in that process still reads and hashes every byte, so a byte altered anywhere is refused at the next claim with the same `SessionLogIntegrityError`. What it skips, for a line whose length and SHA-256 equal what the process verified, is parsing, schema validation and keeping the record; records appended since (by this or another writer) and a log that differs in any way (a changed byte, a shorter or replaced file) are verified in full from byte 0.

New and optional, nothing to change unless you implement them: `LogMedium.identity()` (a medium that does not provide it is verified in full each time) and `LogMedium.scan()` (reads through one reused buffer; `stream` is used without it), `ReadSessionLogOptions.reverify` (with `after`, strict mode: re-check the bytes before the cursor by hash), and `foldSessionLog` / `IncrementalFold` are now exported. The on-disk record shapes are unchanged, and a log written by this version reads on the previous one.

In the CLI, `readConversationFacts` keeps only the facts it answers (a first record, title, archive flag, open turn, last timestamp and a few typed queries) instead of every record of the log; `ConversationFacts.records` is gone from that function's result, and callers that fold messages use the new `readConversationRecords`. This is CLI-internal.
