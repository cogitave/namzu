---
'@namzu/cli': patch
---

Stop bridging clawtool's `Agent*` persona-file tools (`AgentNew`, `AgentList`, `AgentDetect`) into the agent. Those write Claude-Code-style definitions into `.claude/agents/` — a different, redundant mechanism that polluted Claude Code's directory and confused the model alongside namzu's own in-memory dynamic sub-agents. namzu owns sub-agent definition + dispatch natively, so these clawtool tools are excluded from the bridged catalog.
