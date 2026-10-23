---
'@namzu/sdk': patch
---

Fix a re-base (`context-rewrite` compaction) copying the whole conversation into its summary and stripping every message id. When the live context diverged from the recorded view by anything other than an appended tail — most often the provider-rejected-image repair, which rebuilds one middle message as a fresh object — the recorder fell back to inlining the ENTIRE context into the compaction record's `summary` with nothing kept by id, then stripped all ids, so the next re-base was again "not ordered" and re-inlined an ever-larger context forever. One long session reached 53 MB, 76% of it the same context copied dozens of times, which made auto-compaction and resume pathologically heavy (and could abort the process). A re-base now keeps the in-order run of recorded messages by id and re-records only the messages that actually moved, under fresh ids, so repeated re-bases stay bounded and ids survive. No public API change; fold reconstruction is unchanged.
