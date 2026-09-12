---
"@namzu/sdk": major
"@namzu/cli": patch
---

Preserve original messages removed by CLI `/compact`, including exact user details
absent from its summary, for conversation search/read after restart. Failed
retention keeps the existing conversation; messages whose serialized form exceeds
3 MiB are refused before replacement.

SDK consumers handling `compaction_shed.reason` or `ShedPass.reason` exhaustively
must add the new `manual` case. Both manual compaction helpers accept optional
`onShed` to await host-owned retention before returning replacement history;
callback failure rejects the operation. Existing callers without a callback keep
their projection-only behavior.
