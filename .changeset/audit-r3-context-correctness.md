---
'@namzu/sdk': patch
---

Context-management correctness fixes (Vandal round-3 architecture audit).

- **Compaction no longer orphans tool pairs.** `runCompactionCheck` now snaps
  the recent-window boundary through `findSafeTrimIndex` (previously wired only
  to the unused `ConversationManager` strategy classes), so a compaction cut can
  never leave a `tool_result` at the head of the recent window whose `tool_use`
  was summarized away. That orphan otherwise makes the provider reject the very
  next turn with a 400 — compaction killing the long run it exists to keep alive.
- **Resume preserves the compaction summary + working-memory slot.** The
  checkpoint-restore path used to drop EVERY system message, silently losing the
  `[COMPACTED CONTEXT]` block (the only record of the older history a pass
  deleted) on `resumeFromCheckpoint`. It now re-pushes the fresh static/dynamic
  floor but preserves the compaction summary and the pinned working-memory slot.
- **Within-turn usage is merged, not last-write-wins.** `mergeTokenUsage`
  (per-field high-water mark) replaces `usage = chunk.usage` in `collect()` and
  the iteration stream reducer, so a late usage frame that omits input/cache
  tokens no longer zeroes the counts captured earlier in the stream.
- **HITL parks are cancellable.** `awaitDecisionOrAbort` races the tool-review
  and iteration-checkpoint `resumeHandler` parks against the run's abort signal,
  so a Stop that arrives while parked resolves the park as `abort` instead of
  hanging until the host answers. Degrades to a plain await when no controller
  is wired; fails closed to `abort` if the handler rejects.

All changes are internal correctness fixes; the provider/message wire contract
is unchanged and existing consumers stay behaviourally identical outside the
buggy edge cases above.
