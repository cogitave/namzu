---
'@namzu/anthropic': minor
---

Extended thinking, and images inside tool results.

Two more halves the SDK had specified and this driver had not built.

**Extended thinking.** The stream chunk carried a `reasoning` channel whose own comment named the failure — `thinking_delta` and `signature_delta` fell through the driver's `default: // ignore` — the run's aggregator bucketed fragments by index and closed them on `done`, and `ReasoningBlock` recorded the signature with a note that replaying it unchanged is mandatory. The driver requested no thinking, parsed none, and replayed none, so the feature was unreachable on a model where it is off by default and untunable on one where it is on.

It now sends the `thinking` request with the caller's budget, streams each block with its fragments and its signature, closes the block so the aggregator knows the signature has landed, and replays reasoning blocks verbatim and first on the next request. Verbatim is not a style choice: the signature is verified upstream, so a block re-rendered, reordered, or stripped of its signature invalidates the whole conversation rather than that block. A redacted block travels as its opaque payload.

**Images in tool results.** A tool result carrying content blocks was `JSON.stringify`d, so a screenshot reached the model as a wall of quoted base64 — the exact thing the SDK's degrade helper exists to prevent, and pure waste besides: the model paid for every character and could read none of them. This wire carries image blocks inside a tool result natively; the mapper simply never used the shape. Documents still degrade to the named placeholder, because tool results here take text and images, and the wrong block fails the request rather than just the block.

Six previously empty test files now cover this driver: document input, citations, extended thinking, tool-result content blocks, cache-breakpoint placement, and the request shapes the wire rejects outright — an empty content array, an orphan tool result, a `tool_choice` sent without tools.
