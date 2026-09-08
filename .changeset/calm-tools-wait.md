---
"@namzu/sdk": minor
---

Add optional `executionBarrier` metadata to tool definitions and `defineTool`.
Opt a tool in to wait for earlier calls in its model batch and hold later calls
until it settles, enabling ordered write-and-verify batches while independent
read segments remain parallel. Existing concurrency flags and SDK builtin
defaults are unchanged. Nested programs still order dependent calls with `await`;
timeouts retain the existing abandonment behavior for uncooperative tools.
