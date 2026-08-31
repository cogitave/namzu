---
'@namzu/sdk': patch
'@namzu/anthropic': patch
'@namzu/cli': patch
---

Publish `computer_use` through a flat provider-safe model schema while retaining its discriminated runtime validation. Anthropic now rejects root `anyOf`, `oneOf`, and `allOf` tool schemas locally with the offending tool name instead of sending a request that fails with HTTP 400. The CLI receives both fixes and keeps provider-chain diagnostics scoped to their requested home instead of leaking credentials from the process user's home.
