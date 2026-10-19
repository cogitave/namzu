---
'@namzu/sdk': minor
---

A context overflow now recovers in up to two reactive compactions instead of one: if the first relief sheds too little or the retry still overflows, a deeper pass keeps only the newest round-group verbatim (when three or more remain) and clears oversized tool results even inside the recent window. A 400, 413 or statusless failure saying the request is larger than or exceeds the "context window", or "input length and `max_tokens` exceed context limit" is now filed as a context overflow instead of an invalid request, so it reaches compaction. A failed `llmVerification` summary call no longer replaces the overflow as the turn's error; the pass uses the extracted state, and its own overflow is retried with less of the excerpt. When the ladder is spent and compaction errored, the thrown error's message ends in ` · automatic compaction failed: <cause>`.

Nothing to change for callers. With `compactionConfig.circuitBreaker`, the `compaction_failed` event with `cause: 'breaker_open'` no longer carries an `error` line (the cause stays in the union), and the refill breaker's `error` text no longer suggests `/clear`. A host that showed the `breaker_open` line should stop showing it: it only stops proactive compaction, and a real overflow still gets relief. The turn's stop reasons and settlement are unchanged.
