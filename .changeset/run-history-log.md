---
"@namzu/sdk": major
---

The disk run store keeps a run's messages once. Each distinct message is
appended to `<runDir>/history/messages.<g>.jsonl` or `edits.<g>.jsonl`, and
every record that needs a history stores a reference to it: byte ranges plus a
SHA-256 over the referenced bytes. Checkpoints used to copy the whole history
every iteration, and `messages.json` copied it once more at settle. A
50-iteration run goes from 11.2 MB to 2.1 MB and a 200-iteration run from
113.2 MB to 11.7 MB. With `pruneKeepLast: 10` they leave 1.2 MB and 4.5 MB.
Lines no record references any more (pruned checkpoints, rewritten pin slots,
compacted heads) are collected into a new generation once they outweigh the
live ones. Collection deletes an old generation only after the new one, the
history directory and every rewritten record have been fsynced, so a power
loss mid-collection leaves every record pointing at a generation that exists.
On Windows the directory fsyncs are skipped; the platform refuses them.

**What breaks.**

- Checkpoints are written at schema version 3, with a `history` reference
  where `messages` was. An older `@namzu/sdk` refuses them with
  `SchemaVersionError`.
- `messages.json` is written as `namzu.run-message-snapshot.v2`, with a
  `history` reference where `messages` was. An older `@namzu/sdk` refuses it as
  an invalid snapshot.
- `<runs>/index.json` is no longer written: `RunPersistence` no longer calls
  `RunStore.addToIndex`. A custom `RunStore` that relied on that call stops
  receiving it.

Upgrade every process that resumes, drains, lists or exports runs before any
upgraded process writes to the same run directories, and do not roll back
while those runs are in flight. A tool that read checkpoint or `messages.json`
files directly should read through `RunDiskStore`, `DiskCheckpointStore` or
`readRunMessagesIn`, which still return `messages`.

**What does not.** Schema 1 and 2 checkpoints and v1 `messages.json` read
exactly as before. A damaged or missing log is refused, as a damaged inline
record was. `RunDiskStore.listRuns` (deprecated) returns the same rows, now
read from each run's `run.json`, including for runs written before this
version. `RunStore.addToIndex` and `RunDiskStore.addToIndex` are deprecated
and still work when called. Each checkpoint of a listing has message objects
of its own. Checkpoint files are compact JSON.
