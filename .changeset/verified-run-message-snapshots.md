---
'@namzu/sdk': major
---

Make a run's surviving messages readable and bind their publication to the durable event log.

`RunStore.readMessages()` is now required and returns an explicit `RunMessageSnapshot`: `available` includes the messages and the event sequence they were published through, `unavailable` means no snapshot was published, and `legacy-unverified` preserves access to older raw arrays without claiming which log head they represent. The built-in disk and memory stores implement the same contract, and `readRunMessagesIn(runDir)` reads a disk snapshot without creating a run directory.

`RunQuery.fullTranscript()` can now read the surviving snapshot from its bound store when the caller omits the message argument. It combines that verified snapshot with durable `compaction_shed` records and refuses with `RunTranscriptUnavailableError` when publication was interrupted, the snapshot is legacy-unverified, or a resumed run has advanced beyond the snapshot boundary. A missing file is never reported as an empty conversation.

**What breaks:** custom `RunStore` implementations must add `readMessages()` and change `writeMessages(run)` to `writeMessages(run, throughEventSeq)`. Return `unavailable` until a write has actually published the snapshot; do not use an available empty list for missing data. Code that reads the built-in `messages.json` directly must migrate from the former raw array to the versioned `{ format, throughEventSeq, messages }` envelope, or call `readRunMessagesIn`. Older raw-array files remain readable as `legacy-unverified` but cannot support a complete-transcript claim.
