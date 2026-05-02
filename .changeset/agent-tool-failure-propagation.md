---
'@namzu/sdk': patch
---

fix(sdk): Agent tool no longer reports failed subagents as successful

`buildAgentTool` was treating `gateway.waitForTask(handle.taskId)`'s
returned `state === 'completed'` as proof of success and ignoring
the underlying `BaseAgentResult.status`. That was wrong: some
gateways (the SDK's `LocalTaskGateway` for one) forward
`task.state` directly from the agent manager without re-deriving it
from the run's `status`, so a subagent run with `status: 'failed'`
plus a non-empty `lastError` could surface as `state: 'completed'`
and fool the parent into receiving `success: true` with garbage
output.

The check now requires BOTH layers to agree before reporting
success: gateway state must be `'completed'` AND the run's
`BaseAgentResult.status` (when present) must be `'completed'`. On
failure the tool surfaces `lastError` and the disagreement state in
both `error` and `data` so the parent can debug.

Adds three pinned cases in
`packages/sdk/src/tools/coordinator/__tests__/agent.test.ts`
covering: both-agree-success, run-status-failed-but-state-completed
(the regression case), and gateway-state-failed.
