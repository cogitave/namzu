---
"@namzu/sdk": major
---

**`compaction.strategy` defaults to `salience`.** A run under the default now scores every message — recency, relevance to the goal, use by a later turn, repetition — and holds the context near half the window by clearing the least salient tool results and stubbing narrations, without a model in the loop; older history is summarised only at the trigger, as before. The previous default was `structured`: positional retention and a pass only at the trigger. To keep it, pass `compactionConfig: { strategy: 'structured' }`. Measured on the same three-part coding task with a real model: 237k tokens against 271k, the task finished identically; on the eval that plants a fact early and cites it late, salience keeps the fact where structured loses it, with a smaller final history.
