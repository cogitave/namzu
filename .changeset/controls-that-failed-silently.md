---
'@namzu/sdk': major
'@namzu/bedrock': major
'@namzu/http': major
---

Three controls a caller could set that the runtime then quietly declined to apply.

- **`toolChoice: 'none'` permitted tool calls on two drivers.** It means the model must not call a tool. One driver mapped it to the wire's "auto" and the other to `{ type: 'auto' }` — both of which say the model *may*. A caller that had forbidden tool use got a request that allowed it, with nothing in the response to say so. The runtime depends on the guarantee: an advisory consultation passes `'none'` so the advisor answers in prose, into a turn where no executor is waiting for a tool call. Both drivers now answer `'none'` by sending no tools at all, which no wire format can misread.

- **`memoryLimitMb` and `maxProcesses` were dropped by the stronger isolation tiers.** They were applied inside the unconfined tier's branch only, so asking for namespace or profile isolation silently removed the blast-radius caps — a control failing in the one direction nobody checks. They are the same shell builtin on every tier; the stronger tiers now apply them one level in, inside the wrapper they already spawn through, and keep doing their own job. The sibling backend in the sandbox package already refuses per-sandbox controls it cannot enforce rather than ignoring them; this is the same rule, satisfied by enforcing.

- **`AgentManager.dispose()` cancelled nothing.** It called `cancelAll('' as RunId)`, and `cancelAll` filters by parent run — no task has an empty parent, so it matched nothing, and the next lines cleared the instance map. Every live child was released without its abort controller firing: the work kept running, the budget kept draining, and nothing was left holding a reference to stop it. It now cancels every live child before dropping them. `cancelAll` stays scoped to one parent, which is its actual job.

`toBedrockToolConfig` and `buildLimitedSpawn` are exported so the mapping and the spawn shape can be asserted directly rather than through a live process.
