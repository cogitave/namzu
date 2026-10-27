---
'@namzu/sdk': minor
---

A provider chain now moves on to its next member when a member spends its retries on a response that had so far produced only reasoning or the pieces of a tool call still being written. Before, those pieces counted as output and the turn paused with a fallback available. The `fallback` notice on a stream chunk carries a new optional `restart: true` in that case; `query()` drops what the failed member wrote before the next chunk, as it does for a restarting retry. If you read raw chunks from `withProviderFallback`, discard the fragments you collected when `fallback.restart` is set.
