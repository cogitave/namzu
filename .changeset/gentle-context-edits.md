---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Reclaim context by clearing stale tool output, before summarizing
destructively.

Compaction was all-or-nothing: once the threshold hit, every older message
became a summary and the agent's own reasoning — the decisions, the false
starts it learned from, the exact wording of a plan — was paraphrased away
with it. That is a heavy price for a context problem usually caused by
something much dumber: a handful of enormous tool outputs the agent already
read, took what it needed from, and moved past.

`clearStaleToolResults` replaces the OUTPUT of old, large tool results with
a short placeholder that names the tool and its original size, so a result
that turns out to still be needed is one tool call away rather than lost.
It is safe where trimming is not, because nothing moves — the `tool` message
keeps its position and its `toolCallId`, so `tool_use` ↔ `tool_result`
pairing is intact by construction.

It runs first in `runCompactionCheck`; if it gets the context back under
`triggerThreshold`, summarization is skipped entirely and the history stays
verbatim. New `CompactionConfig` fields: `clearToolResults` (default
`true`), `keepRecentToolResults` (3), `minToolResultCharsToClear` (1000),
`preserveToolResultsFrom`.

Never clears an error result (the error is what steers the next turn), the
most recent N results (still in use), or anything below the size floor
(the placeholder would cost as much). Image payloads are measured by their
base64 size — a screenshot is the largest thing a tool result can carry and
exactly the kind of output an agent reads once.
