---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A recall step run with `record: true` now says which stored memories it added to the conversation: `RecordedContextItem.recalledMemories` carries them, and the loop emits a `memory_recalled` session event (persisted; `memory.recalled` on the SSE wire) once the entry is recorded. A consumer that switches exhaustively over `SessionEvent['type']` must handle the new member. The CLI shows `Used N memories (ctrl+o to expand)` under the message, one line per memory behind ctrl+o with `/memory delete <name>` to remove one, live and on resume.
