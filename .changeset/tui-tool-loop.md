---
'@namzu/cli': minor
---

**The TUI can now run tools — namzu actually does work, not just talk.**

The interactive TUI previously streamed plain text via the provider's single-shot `chatStream()` primitive, so the model could answer but never call a tool. The turn now drives the SDK agent loop (`query()`) with a `ToolRegistry` of the builtin tools (`bash`, `read`, `write`, `edit`, `append`, `glob`, `grep`, `verify_outputs`). The model can read files, run shell commands, and edit code; tool results are fed back and the loop iterates until the turn settles.

Tool activity is surfaced live in the transcript: a new `tool` line (⚙) shows each call (`bash › echo hi`) and failures are reported inline. The SDK logger is silenced while the TUI is mounted so log lines never corrupt the rendered frame.

Tools currently run under `permissionMode: 'auto'` (auto-approved); an interactive permission prompt is a follow-up. clawtool's MCP tools are not yet bridged into the registry — the builtin set covers bash/read/edit today.
