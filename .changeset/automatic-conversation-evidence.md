---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add experimental `createEvidenceRecallStep` and its typed host retrieval contract.
It ranks a bounded pool of authenticated historical passages and supplies exact
excerpts with source/error/preview labels in request-only context. Every request
revalidates ownership and source data; deadlines discard late reads without
accumulating overlapping retrieval or replaying actions.

Recorded CLI conversations can opt in with `compaction.recallEvidence: true`.
The default remains off. Automatic recall excludes the requesting invocation;
explicit conversation search/read still cover live evidence, more pages and
complete text. This adds historical context, not automatic verification of
current workspace state or a guarantee of exhaustive recall.
