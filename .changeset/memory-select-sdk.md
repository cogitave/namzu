---
'@namzu/sdk': minor
---

`createMemoryRecallStep` accepts `select`, `shortlist`, `minCoverage` and `selectTimeoutMs`, so a host can let a model choose among the lexical candidates once per user message. `RecalledMemory` and the `memory_recalled` event (and the SSE `memory.recalled` payload) gain an optional `reason`. A step given `select` or `shortlist` gets a header that says to use a record only if it applies, and, when the words chose and more matched than were injected, a closing line "N other memories matched; search_memory can find them." Nothing changes for a caller that passes none of the new options: its block is byte-for-byte the earlier one.
