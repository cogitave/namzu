---
"@namzu/sdk": major
"@namzu/cli": patch
---

Keep large compacted histories searchable, including short user text attached to
large images and individual long text messages. The disk store writes a bounded
`compaction_archive` storage record and saves original messages and authenticated
text chunks under the run's `compaction-output/` directory. Full SDK event readers
restore the original `compaction_shed` event with its attachments and metadata.

Raw JSONL consumers must handle this new storage record or switch to
`RunDiskStore.readEvents()` / `readRunEventsIn()`. Preserve `compaction-output/`
with the transcript when copying a run. Upgrade SDK readers before consuming new
archives. Existing inline records remain readable; older oversized records are
not converted automatically.

CLI manual compaction now offloads messages above 3 MiB instead of refusing them.
Automatic compaction and scoped search/read use the same SDK mechanism. Archive
write failures and limits still prevent the history replacement.
