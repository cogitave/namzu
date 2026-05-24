---
'@namzu/cli': minor
---

**clawtool's tools are now built into the TUI agent.**

When the local clawtool daemon is reachable, namzu folds its MCP tool catalog into the agent's tool registry alongside the SDK builtins — so the model can use clawtool's web/browser/sandbox/git/sub-agent/skill tools (e.g. `clawtool_WebSearch`, `clawtool_BrowserFetch`, `clawtool_SandboxRun`, `clawtool_Commit`, `clawtool_Spawn`) without any extra setup. A warm daemon contributes ~72 tools (its full catalog minus the six that duplicate builtins: Bash/Read/Edit/Glob/Grep/Write).

Bridged tools are namespaced `clawtool_<Name>`, flagged destructive (so the permission prompt gates them), and execute by forwarding to clawtool's `tools/call`. Loading is best-effort with a hard timeout: if clawtool is absent, down, or slow, namzu silently runs on builtins alone — startup never fails because of it. The connect line now reports the total tool count.
