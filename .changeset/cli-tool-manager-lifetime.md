---
'@namzu/cli': patch
---

Releases live toolset change listeners when a CLI session or turn ends, including a send with extra per-turn tools. Closing the session keeps its plugin and MCP connection cleanup while dropping the host-side manager subscriptions.
