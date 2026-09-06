---
'@namzu/sdk': patch
---

Reject missing session, topic, project or tenant identity at the start of
`query` and `drainQuery`, before model calls or filesystem persistence. Untyped
callers could previously omit `topicId` and still run despite the required
TypeScript input. Supply all four identity fields, or use `runAgent` to generate
them. Invalid calls now report `invalid_config` with `details.missingFields`.
