---
"@namzu/sdk": major
---

The disk checkpoint store keeps a run's message history once instead of
copying it into every checkpoint. A checkpoint now stores a reference into two
per-run logs beside it: `checkpoints/history.jsonl` and
`checkpoints/history-edits.jsonl`. The reference records byte ranges and a
SHA-256 over the referenced bytes, and a missing or altered log refuses the
checkpoint just as a damaged inline one is refused. A 50-iteration run's
checkpoints go from 10.2 MB to 1.3 MB, and a 200-iteration run's from 108.8 MB
to 7.6 MB.

**What breaks.** Checkpoints are now written at schema version 3. An older
`@namzu/sdk` refuses them with `SchemaVersionError` instead of reading a
checkpoint that has no messages. Upgrade every process that resumes, drains or
lists runs before any upgraded process writes to the same run directories. Do
not roll back while those runs are in flight. A tool that read checkpoint JSON
files directly finds `history` where `messages` was. Read through
`RunDiskStore` or `DiskCheckpointStore`, which still return `IterationCheckpoint`
with `messages`.

**What does not.** Checkpoints written at schema 1 or 2 are read exactly as
before. No exported type or signature changed, and custom `CheckpointStore`
implementations are unaffected. Checkpoint files are now compact JSON.
