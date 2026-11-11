---
'@namzu/cli': major
'@namzu/sdk': patch
---

When you come back to a conversation that stayed open in the same terminal after the provider's prompt cache has expired (a conversation resumed in a new process is not covered, because nothing is saved to disk), Namzu now replaces old, large tool results with a short note before the first request, if that saves at least 20,000 tokens; the newest six results, errors and pinned messages are never touched, and each note says how to read the result again. The full text stays in the conversation log (and nothing is shed when `recordShedHistory` is off). Nothing to change on your side; set `compaction.clearStaleResultsAfterIdle: false` to keep sending old results unchanged. SDK: `CompactionConfig` gains an optional `clearStaleToolResultsAtStart` that a host can set per turn for the same effect; absent, nothing changes.
