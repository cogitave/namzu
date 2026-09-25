---
'@namzu/sdk': minor
---

Releases live toolset change listeners when a turn or duplex session ends, including abandoned streams and failed duplex connections, so repeated runs using one MCP toolset do not retain earlier tool managers. `ToolManager.dispose()` unsubscribes without closing caller-owned toolsets; direct `ToolManager` users should call it when finished. Agent front doors now check every exposed config field against its runtime destination, and the deprecated `runAgent.verificationGate` option again applies the authorization policy. Supplying distinct policies under both gate names fails before the model runs.
