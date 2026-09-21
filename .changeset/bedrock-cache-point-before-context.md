---
'@namzu/bedrock': patch
---

Two fixes to the Converse request.

- **The message cache point ends the history.** It was placed after the last
  message. The runtime now appends request-only context there (the
  working-memory slot, `context` prompt contributions, step context), which
  changes on every request, so every request wrote a cache entry no later
  request could read. The point now sits after the last block before the first
  request-only context message, as in the Anthropic driver.
- **Consecutive same-role messages are merged.** Converse requires the
  conversation to alternate between `user` and `assistant`, and the runtime
  sends tool results followed by request-only context — two user turns — on
  every step after a tool call. Their content blocks are now concatenated in
  order into one message.

No configuration changes.
