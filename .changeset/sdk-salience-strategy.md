---
"@namzu/sdk": minor
---

A new compaction strategy, opt-in: `compaction.strategy: 'salience'`. Every message is scored without a model — recency with a half-life, BM25 relevance to the goal (the task, the live requirements, the open task-list items, the latest intent), whether a later turn used it, and whether a later message repeats it — and from `softTarget` (half the window by default) the least salient tokens are evicted first: a tool result's body cleared to the same placeholder the stale-result pass uses, an assistant narration cut to its first sentence. No message is removed and no pair is split, so it runs on every iteration; the summary path is reached only at `triggerThreshold`, as before. `compaction_tool_results_cleared` gains an optional `stubbedCount`. `structured` remains the default and is unchanged. The scoring core (`scoreMessages`, `buildGoal`, `planWorkingSet`) is exported from the compaction module for a host that wants to render or tune it.
