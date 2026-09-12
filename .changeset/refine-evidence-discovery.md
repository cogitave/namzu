---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Add the experimental `refineEvidenceRecallTerms` SDK helper for bounded lexical
coverage checks. Hosts can use the returned strict query subset to search terms
missing from candidate excerpts without introducing another model call.

When `compaction.recallEvidence` is enabled, the CLI spends existing retrieval
pages on uncovered terms so frequent words are less likely to hide an earlier
observation. Original and focused cursors retain their own query and omission
state. The four-page, two-live-page and 8 MiB read limits remain in force;
explicit conversation searches retain literal matching. No configuration or
stored-data migration is required.
