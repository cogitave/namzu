---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Allow delegated CLI agents to opt into a separate managed Git worktree with
`workspace: "worktree"`. The child runs from the selected checkout's committed
HEAD and the worktree remains available for review after any outcome. SDK
callers can choose a per-child shared or isolated workspace and explicitly
retain it. A manager can make omitted choices shared with
`workspaceDefault: 'shared'`; existing SDK backend provisioning and cleanup
remain the defaults.
