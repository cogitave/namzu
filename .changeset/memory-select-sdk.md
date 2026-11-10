---
'@namzu/sdk': minor
---

`createMemoryRecallStep` accepts `select`, `shortlist`, `minCoverage` and `selectTimeoutMs`, so a host can let a model choose among the lexical candidates once per user message. `RecalledMemory` and the `memory_recalled` event (and the SSE `memory.recalled` payload) gain an optional `reason`. The recalled block now ends with "N other memories matched; search_memory can find them." when more matched than were injected, and its header says to use a record only if it applies. Nothing changes for a caller that passes none of the new options, apart from that line and sentence.
