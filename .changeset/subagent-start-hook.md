---
'@namzu/sdk': minor
---

New hook event `subagent_start`, fired when a delegated child session starts, before the child's first prompt. It carries `parentSessionId`, `parentTurnId` and `agentType`; a hook may answer `annotate` to add context to the child's turn. Shell hooks can attach to it (`SubagentStart` in a hook's JSON, `agent_id` and `agent_type` on stdin, `matcher` tested against the agent name). `subagent_stop` also carries `agentType`. Nothing changes for code that does not register the new event; code that switches exhaustively over `PluginHookEvent` needs a case for it.
