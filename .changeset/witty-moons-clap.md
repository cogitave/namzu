---
'@namzu/sdk': minor
---

Stop compaction from quietly degrading the state it produces, and implement
`resetThreshold`.

What survives compaction is the only record of the history it replaced, so
silently shrinking it is the one thing that structure must not do. Three fixes:

**Capped lists keep their head.** Eviction used `shift()` — oldest-first — so
on a long run the 26th assistant note deleted the 1st, and "the structured
state that survives compaction" degraded into a rolling window over recent
activity. The early entries are the load-bearing ones (the original
requirement, the decision that set the approach); the recent ones are still in
the un-compacted tail of the conversation. The first `keepFirstEntries`
(default 3) are now pinned and eviction takes from the middle. Tool results
keep oldest-first eviction, because there recency genuinely wins: an old `read`
of a since-edited file is worse than useless.

**The summary admits what it lost.** Evictions are counted per slot and
rendered as `_(N entries dropped to stay within the state budget)_`. A summary
that presents a gap as complete is worse than one that admits the gap — the
model reasons about a fragment as if it were the whole record.

**Unrecognised tools get a useful summary.** Every MCP tool, custom tool and
connector-bridged tool fell into a flat 120-character head slice, which on JSON
spends the entire budget on syntax: `Ran: {"results":[{"id":"a1b2` and nothing
else. Unknown tools are the ones a summary can say least about from the name,
so they now get 400 characters and a structure-aware slice — array length and
element shape, or object keys — falling back to head-and-tail for plain text.

**`resetThreshold` is implemented rather than deleted.** It was declared, set
by the shipped CLI, and read by nothing. It is hysteresis: a pass that only
moves the context from 0.72 to 0.71 of the window leaves the trigger armed, so
the next iteration compacts again, paying a summarization call and busting the
prompt-cache prefix each time for nothing. A pass that cannot reach the reset
level now logs the shortfall, and `compaction_completed` carries
`reachedResetThreshold`.
