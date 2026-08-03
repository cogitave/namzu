---
'@namzu/sdk': minor
---

A message can be pinned against eviction

Everything a run protected from compaction was protected by **position**: the leading system messages, the working-memory slot, the last N turns, the most recent tool results. A standing constraint stated in the middle of a conversation — "the account id is 4471; never bill a different one" — therefore aged out at the same rate as chatter. No positional rule could express it, and the working-memory slot could not either: it is host-rendered each turn and does not know what the user said.

`retain: true` on a message says it directly. The summarization rebuild carries pinned turns over verbatim, in order, between the summary and the recent window, and the in-place tool-result clearing pass leaves their content alone — clearing keeps the message and replaces its content, which is exactly the loss the marker was asked to prevent.

Protection is transitive across a tool pair: pinning a `tool_result` pins the assistant turn that issued the call, and pinning that turn pins every result answering it. Half a pair is not a smaller history, it is one the provider rejects.

Nothing caps how much may be pinned. Pinned turns are exempt from the reclaim that keeps a long run alive, so this is a budget the setter spends — a cap would have to guess which pin mattered, and dropping the wrong one quietly is worse than a run that overflows in the open.
