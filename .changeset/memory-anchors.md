---
'@namzu/cli': minor
'@namzu/sdk': minor
---

A remembered fact about files now says when it may be out of date. When Namzu stores a memory that names files in your project, it records each file's path, size, time and a hash (never the content). When that memory is about to go with a message and one of those files is gone or has changed, the memory is still shown but carries a note that it may be out of date, and the idle sweep retires an automatically recorded memory whose files stayed gone or changed for 14 days (`/memory` restores it). Nothing to change on your side. For SDK hosts: `createMemoryRecallStep` takes an optional `caution(record)` callback and `RecalledMemory` gains an optional `caution` string; existing callers are unaffected.
