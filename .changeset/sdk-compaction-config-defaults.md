---
"@namzu/sdk": patch
---

`query` applies the compaction schema's defaults to a partial `compactionConfig`. A host that passed only a strategy and a window reached the compaction phase with `triggerThreshold` undefined, and `usage < undefined` is false: the pass ran on every iteration, and the salience strategy fell through to the stale-result clearing it exists to replace. Pass what you mean; the rest is filled in.
