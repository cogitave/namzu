---
"@namzu/sdk": minor
---

Admit a whole-file `read` as visible file evidence, so the derived work context
references a body the model already has in a receipt instead of leaving it to
read the file again.

`FileReadTracker` gains two optional methods. `recordFullRead(key, content,
callId, renderedFingerprint)` does everything `recordRead(key, content)` does —
always with the whole file, never the window — and additionally records that the
body is visible in that call's receipt; `readWitness(key)` reports
`{ callId, renderedFingerprint }`. Both are optional, so a custom tracker that
implements neither keeps its behavior exactly, and `createFileReadTracker()`
implements both. The built-in `read` calls `recordFullRead` only when nothing
narrowed the read, and falls back to `recordRead` for a tracker without it.

`renderedFingerprint` is of the tool's own output string, not of the file's
body: a read's body survives only as the line-numbered rendering its receipt
carries, so the projection admits the entry only while the receipt it can see
fingerprints to exactly what the tool emitted. A result the output budget elided
or spilled, one compaction cleared, or one changed in any other way withholds
the path, and nothing anywhere recovers a body by undoing the numbering. A
receipt over 32,000 UTF-16 units is not read at all; a larger file is not
admitted this way.

Such an entry carries `kind: "read"` and never `editsInCalls` — a read roots no
chain, and the first `edit` on the path withdraws it. Read-rooted entries count
against the same six paths as the write-rooted ones, which keep a path both
could claim. Existing write and chain entries are unchanged, mutation-time
drift checks are untouched, and nothing here reads the filesystem.
