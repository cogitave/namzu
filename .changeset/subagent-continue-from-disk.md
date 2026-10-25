---
'@namzu/sdk': minor
---

A delegated child saved by an earlier process can now be continued. Pass `continuationProfile` (up to 16 short string entries, never a secret) to `createTask` when launching the child; it is written to the child's `meta.json`. In a later process, call the new optional `TaskScheduler.restoreChild({ childSessionId, workingDirectory, agentFor })`, which checks the saved log and meta under the invoking parent and re-creates the continuation that `createTask({ resumeSessionId })` needs, then continue the child with that call. It answers `{ status: 'refused', reason }` for a child with no profile, an isolated workspace, an unfinished turn, or one that was cancelled. Nothing changes for callers that do not use it; `ChildSessionMeta` gains an optional `continuation` field and `AgentManagerContract` an optional `restoreChildConversation`.
