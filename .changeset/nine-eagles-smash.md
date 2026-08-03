---
'@namzu/sdk': minor
'@namzu/anthropic': minor
---

Parse reasoning out of the stream, and let a run request extended thinking.

This completes the reasoning work: the previous release added storage and
verbatim replay, but nothing populated it. `StreamChunk.delta` carried only
`content` and `toolCalls`, so the Anthropic driver's `thinking_delta` and
`signature_delta` events fell through its `default: // ignore` — the blocks
could not be captured even in principle. Two consequences: the verbatim-echo
contract was unsatisfiable in practice, and a streaming UI showed a
multi-second stall with zero events while the model was demonstrably working.

- `StreamChunk.delta.reasoning` carries fragments bucketed by block index,
  exactly like `toolCalls[].index`, closed by `done`.
- `streamProviderTurn` accumulates them and attaches the finished blocks to
  the response in **stream-index order**, not arrival order — a provider may
  interleave blocks, and the echo contract is about the original ordering.
- New `reasoning_started` / `reasoning_delta` / `reasoning_completed` run
  events, wire-mapped as `reasoning.*`. The delta is ephemeral, so the
  transcript records the completed block rather than every fragment.
- The Anthropic driver handles `content_block_start` for
  `thinking`/`redacted_thinking`, forwards `thinking_delta` and
  `signature_delta`, and closes the block on `content_block_stop`.
- `AgentRunConfig.thinking` (`ThinkingConfig`) is forwarded on every model
  call. The Anthropic driver maps it to `thinking` and **omits
  temperature/top_p/top_k while it is enabled**, because the API rejects them
  together — sending a request known to 400 is worse than dropping a sampling
  knob the caller did not prioritise.

Reasoning rides on the assistant message it belongs to, so the replay contract
holds automatically: trimming or compacting that message takes its thinking
blocks with it, and no separate atomicity rule is needed in `findSafeTrimIndex`.
