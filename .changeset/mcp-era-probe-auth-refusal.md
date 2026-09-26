---
'@namzu/sdk': patch
---

MCP Streamable HTTP connections now surface a 401 or 403 response to the modern protocol probe as an access failure, without attempting a legacy initialize handshake. Correct the server credentials or access policy and reconnect.
