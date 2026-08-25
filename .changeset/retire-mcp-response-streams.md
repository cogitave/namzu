---
'@namzu/sdk': patch
---

Retire MCP stdio connections immediately when their response stream ends, reject pending calls without waiting for the request deadline, and preserve ownership of a still-live server process through reconnect and teardown.
