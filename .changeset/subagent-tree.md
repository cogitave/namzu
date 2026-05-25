---
'@namzu/cli': minor
---

**Sub-agent delegations now show what the sub-agent did.**

When the agent delegates via the `Agent` tool, the sub-agent's own tool steps are collected while the call runs and shown as a `├─/└─` tree beneath the delegation's result — so you can see the work the sub-agent performed (e.g. which files it read or commands it ran), collapsible with Ctrl+O like any tool output.
