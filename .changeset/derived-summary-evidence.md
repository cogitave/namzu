---
"@namzu/sdk": minor
"@namzu/cli": patch
---

System messages can now carry `source: { type: 'compaction-summary' }`.
Kernel-generated compaction summaries receive this marker. When retained,
their text is searchable and readable as `compaction_shed:summary`, preserving
exact text and existing part positions. Ordinary system text with the same
heading and older unmarked archives keep their previous classification.

Automatic evidence recall orders matching source records before known derived
summaries within its bounded candidate pool, using separate relevance statistics.
Summaries remain available as passages and exact read addresses; they are not
deleted. CLI evidence guidance explains that these are derived text, not
independent observations. Recall limits and opt-in settings are unchanged.
