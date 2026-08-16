---
'@namzu/sdk': patch
---

The task and session disk stores now read, write and scan through the
shared `DiskRecordStore` primitive instead of hand-rolling each.

Between them they carried two private `readJson`/`atomicWriteJson` pairs
and sixteen `readdir` scans — the same twenty lines, four times over, in
the two stores whose scan semantics the comments themselves call subtle.
Every property fixed in one had to be remembered into the others, and the
properties are not obvious ones: a missing file is an empty read rather
than an error, a record from a newer build is refused rather than read
partially and written back with the difference gone, and a listing needs a
stable order.

No behaviour changes. The append-only session event log and
`messages.jsonl` are deliberately left alone — they are log-shaped, not
record-shaped, each line is a whole record carrying its own stamp, and
forcing them through a record store would be a worse fit than the
duplication it removes.
