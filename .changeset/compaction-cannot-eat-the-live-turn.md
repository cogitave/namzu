---
'@namzu/sdk': patch
---

Compaction can no longer delete the turn it is compacting.

The recent-window boundary was snapped FORWARD to avoid splitting a tool pair,
but that walk skips leading `tool` messages with no stop short of the end of the
transcript. Whenever the whole suffix from the naive boundary is `tool` messages —
one assistant turn fanning out at least `keepRecentMessages` parallel calls,
measured at the start of the very next iteration, which is exactly where the
compaction check runs — the boundary landed on `messages.length`, the recent
window came back empty, and the rebuilt transcript held no non-system message at
all. The model was then asked to answer a conversation whose last turn, including
the user's own message, had been removed. The existing older-message floor guard
cannot catch it: in that shape the older half is the whole transcript.

The boundary is now the largest safe one AT OR BELOW naive, so a pass never
removes more than the naive cut would and at least `keepRecentMessages` original
messages always survive verbatim. When no safe boundary exists the pass is
skipped and the transcript is left intact — one iteration of context headroom is
cheaper than the live turn, and the condition clears itself as soon as the next
assistant message moves the boundary past the tool block. The same change stops
the leading system prompts being duplicated into the recent window when the naive
boundary lands inside the system prefix. `findSafeTrimIndex` is unchanged and is
reused as the safety predicate.

Two smaller silent losses in the same area:

An empty verification reply is now treated like `COMPLETE`. A truncated turn, a
refusal, or an exhausted `llmVerificationMaxTokens` produced an empty string,
which fell through to the append path and stamped a bare
`## LLM Verification Additions` heading with nothing under it — an empty promise
that then rode in every subsequent system prompt for the rest of the run.

Every compaction count is `z.number().int().positive()` instead of
`z.number().positive()`. Zod's base number check rejects only non-numbers and
`NaN`, so `Infinity` and fractional values both parsed. `Infinity` was the
dangerous one: it disarms the budget it guards rather than failing, so
`convoTextBudget: Infinity` made `truncateMessages` a no-op and the entire older
history was pasted into the verification prompt.
