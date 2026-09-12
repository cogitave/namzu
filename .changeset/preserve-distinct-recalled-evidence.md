---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Fix repeated historical observations filling every automatic evidence-recall
passage slot and excluding a different record such as a correction. Exact equal
text with the same producer, retention and error status now shares a passage
before bounded BM25 scoring. Copies retain their separate source addresses;
changed identifiers, previews and errors remain distinct.

Request context includes `otherOccurrences` for additional addresses and
`omittedOccurrences` when the character allowance cannot hold all addresses in
the retrieved pool. Distinct text takes priority over extra addresses. No archive
record is removed, no current-state or cross-run chronology is inferred, and
explicit search/read tools are unchanged. CLI automatic recall remains opt-in
with `compaction.recallEvidence: true`; no read or passage limits increase.
