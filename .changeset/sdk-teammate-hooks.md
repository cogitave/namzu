---
"@namzu/sdk": minor
---

Adds the hook events `teammate_idle`, `teammate_start` and `teammate_stop` (shell hooks read `TeammateIdle`, `TeammateStart` and `TeammateStop`; `PluginHookContext` gains `teammateName` and `teamName`). A shell hook on `teammate_idle` that exits `2` refuses the idle: its stderr is the feedback and the teammate keeps working; the other two cannot refuse. `task_created` and `task_completed` also carry `teammate_name` and `team_name` (`teammateName`, `teamName`) when a teammate makes or completes the task; new optional `taskTeam` on `AgentInput`, `QueryParams` and `CreateTaskOptions` names the team. The ACP permission request gains an optional `teammate: { name, team }` so a client can name the member that is asking. Nothing changes for a session with no teams: the new fields are absent. A hook config that used `TeammateIdle` as an unknown event name (it was reported as "not an event this kernel has") now runs.
