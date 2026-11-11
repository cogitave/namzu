---
'@namzu/cli': minor
'@namzu/sdk': minor
---

A remembered fact about files now says when it may be out of date. When Namzu stores a memory that names files in your project, it records each file's path, size, time and a hash (never the content). When that memory is about to go with a message and one of those files is gone or has changed, the memory is still shown but carries a note that it may be out of date, and the idle sweep retires an automatically recorded memory whose file stayed gone for 14 days (`/memory` restores it). A file that only changed adds the note and never retires the memory, and `/memory` says whether a memory you saved is possibly stale because a file is gone or because it was not recalled. Files that commonly hold a secret (`.env`, keys, credentials) are never recorded. Nothing to change on your side. For SDK hosts: `createMemoryRecallStep` takes an optional `caution(record)` callback and `RecalledMemory` gains an optional `caution` string; existing callers are unaffected.
