---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Recover text blocks in compacted tool results that also contain images or
documents. Scoped conversation search and exact reads now include those blocks
after compaction and restart, without mixing binary bytes or inserted separators
into the text. Existing plain-text part addresses keep pointing to the same
content. Newly written large archives retain the additional text parts; old
archives are not rewritten. Unindexed legacy scans report skipped block arrays
as incomplete instead of claiming a complete search. No configuration changes
are required; automatic CLI recall remains opt-in.
