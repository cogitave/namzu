---
"@namzu/sdk": minor
"@namzu/cli": patch
---

A compaction pass that edits a message in place (a long narration cut to its first sentence, a large tool result cleared) now appends one small `message_edited` record per edited message. Before, the session log held a `compaction` record plus a new copy of every message after the first edited one, on every turn: in a long session held at its soft target that was most of the log. The context a reader folds from the log is the same and the original text stays in the log. New record type `message_edited` (`MessageEditedRecordSchema`), flagged `ignorable`: an earlier release reading a log this version wrote skips it and folds the original, unedited text of those messages (the same messages, order and ids), and the next compaction pass cuts them down again. No existing record gains a field or a value. A host that sends back history it cached before a pass is still accepted, at no extra read of the log per message. A pass that swaps a message for a copy with the same text appends nothing. `@namzu/cli` reads a session's first record, not its whole log, to start a turn.

A turn resumed from a log whose fold begins with a compaction summary no longer re-bases the fold on the summary alone: before, the recorded messages after the summary dropped out of the fold, and the next resume loaded the shortened context.
