---
'@namzu/sdk': minor
'@namzu/cli': minor
---

An agent file can now carry a `permissionMode:` line. `@namzu/sdk` reads it into `AgentFileDefinition.permissionMode` and, when a host passes `permissionModes` to `discoverAgentDefinitions`, reports a file naming any other word instead of loading it. In `@namzu/cli`, `plan` and `accept-edits` narrow a delegated agent whose parent asks before changes; a parent in any other mode keeps its own mode in the agent, and a file cannot ask for `bypass` or `auto`. Nothing to change to keep working: a file without the line behaves as before.
