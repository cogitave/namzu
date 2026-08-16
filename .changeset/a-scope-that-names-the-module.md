---
'@namzu/sdk': minor
---

Every log record now names the module that emitted it.

40 call sites across 36 SDK modules bound `component: '<ClassName>'` on their
`child()` logger. `component` is deliberately inert — it is not an alias for the
reserved scope key — so those records carried the *default* `scope.name` and a
redundant attribute instead. `AgentBus`, `SkillRegistry`, `DiskTaskStore` and 33
others were, in effect, unattributed.

They now bind `SCOPE_ATTRIBUTE`, and the value is the module path
(`bus`, `skills/registry`, `store/task/disk`) rather than the class name — the
shape `ManagedRegistry` already used. A scope that varied per instance would not
be a scope.

What a `LogSink` sees change:

- `record.scope.name` is a module path instead of the root scope's name.
- `attributes.component` is gone. A host filtering on it should filter on
  `record.scope.name`.
- Four keys are new where the class name or an id carried information the module
  path does not: `namzu.connector.type` and `namzu.execution.type` (the concrete
  subclass behind `connector/base` and `execution/base`), `namzu.mcp.server.id`
  (the MCP server this process hosts — deliberately not
  `namzu.connector.server.id`, which identifies a *remote* being dialed), and
  `namzu.sandbox.id`. `runtime/bidi/session.ts`'s bare `runId` binding became
  `namzu.run.id`.

`NAMZU` gains those four members, which is why this is a minor rather than a
patch. `scripts/log-standard.json#unnamespacedBindingCount` moves 40 → 0, so the
next `component:` binding fails CI rather than joining a budget.
