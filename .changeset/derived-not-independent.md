---
'@namzu/sdk': patch
---

Four arithmetic defects, each pinned by a computed counterexample.

- **`mergeTokenUsage` maxed `totalTokens` as an independent field.** It is
  derived (`input + output`), and Anthropic reports the input on
  `message_start` and the output on `message_delta` — so the two frames
  carry totals of 1200 and 350, and the max returns the larger *component*
  rather than the sum. Merged: 1200. Correct: 1550. Every completion token
  was invisible to the token-budget hard stop, which reads only
  `totalTokens`. The merge now also takes `prompt + completion`, so it is
  monotone and can never under-report.

- **The compaction estimator counted array-shaped tool results by block
  count.** `msg.content.length` on `ToolResultBlock[]` is the number of
  blocks, so a tool result carrying a 400 KB screenshot contributed **1**
  character — and the estimate that decides when to compact read near zero
  for exactly the runs that need compacting most.

- **`toolsHash` omitted `annotations`.** Those carry `readOnlyHint` and
  `destructiveHint`, which become `isReadOnly` / `isDestructive` and drive
  whether a human reviews the call. A server could flip a tool from
  destructive to read-only — same name, same schema, silently removed from
  review — and the fingerprint built to catch that rug-pull produced an
  identical hash.

- **Sub-agent budget exhaustion inverted into no budget.**
  `floor(remaining * maxBudgetFraction)` reaches 0 once the parent drops
  below `1 / maxBudgetFraction`, and `tokenBudget: 0` means *uncapped*
  downstream (`LimitChecker`: `tokenBudget > 0 && …`). So the most depleted
  parent in the tree was the one that spawned an unlimited child. Spawning
  now refuses with a clear error; a caller who wants an uncapped child says
  so explicitly.
