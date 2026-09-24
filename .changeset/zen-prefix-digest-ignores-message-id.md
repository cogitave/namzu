---
'@namzu/zen': patch
---

Native replay could be wrongly invalidated by `@namzu/sdk`'s new `BaseMessage.id` field: `createReplayState`'s `prefixDigest` hashed a message's earlier-turn prefix without excluding `id`, so two requests built from the exact same prefix content disagreed on the digest whenever one side was a fresh, never-recorded copy of the other (or a fork's copy, carrying a different session's id for identical content) — a real reasoning/tool-call replay would have been discarded and resent to the model as plain text for no content reason. `id` is now excluded from `prefixDigest` alongside `timestamp`, which it already ignored for the same reason.
