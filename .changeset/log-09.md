---
'@namzu/sdk': minor
---

A logger's module identity can now be set independently of any log attribute: `Logger.child()` special-cases a new reserved key, exported as `SCOPE_ATTRIBUTE` (`'namzu.log.scope'`), that rebinds `LogRecord.scope.name` — an OTel-shaped field a host can filter stderr/JSON output on to silence or isolate one module — for that logger and every child it produces afterward, rather than being copied into `attributes`.

This closes a real bug in the pre-existing (but previously unreachable-in-practice) `scope` field: every logger obtained via the deprecated `getRootLogger()` reported the SAME `scope.name` (`'namzu'`) no matter what module built it, because the internal adapter between `getRootLogger()` and the record pipeline hardcoded its scope on every `child()` call. That adapter is fixed in this release as part of wiring `SCOPE_ATTRIBUTE` through it.

**If you parse stderr JSON:** a small number of call sites migrate their bare, un-namespaced `component` attribute to `scope.name` plus a namespaced `namzu.*`/`gen_ai.*` attribute in this release (the remaining `component:` sites are unaffected and continue to work exactly as before — see the tracking follow-up for the rest):

| file (component) | old bare key(s) | new |
|---|---|---|
| `ManagedRegistry` (all 5 subclasses) | `component` | `scope.name: 'registry'` + `namzu.registry.name` |
| `AbstractAgent` | `component`, `agentId` | `scope.name: 'agents'` + `gen_ai.agent.id` (reused, not re-minted) + new `namzu.agent.type` |
| `RouterAgent` | `component`, `agent` | `scope.name: 'agents'` + `gen_ai.agent.name` (reused) |
| the run's own correlated logger (`RunContextFactory.buildLogger`) | `component`, `agent`, `sessionId`, `threadId`, `projectId`, `tenantId` | `scope.name: 'runtime/query'` + `gen_ai.agent.name` + `namzu.session.id` / `.thread.id` / `.project.id` / `.tenant.id`; a nested run also now carries `namzu.run.parent_id` when `parentRunId` is set — previously dropped on the floor |
| `ConnectorManager` / `TenantConnectorManager` | `component` | `scope.name: 'manager/connector'`; a tenant-scoped manager's connectors now carry `namzu.tenant.id`, previously unreachable because `ConnectorManager` had no logger input at all |
| `InMemoryCredentialVault` | `component`; `'namzu.credential.id'`/`'namzu.credential.label'`/`'namzu.tenant.id'` as raw string literals | `scope.name: 'vault'`; same attribute VALUES, now referenced via constants — no wire-format change on the attribute keys themselves |
| `MCPClient` | `component`, `serverId` (bound to the operator's own configured name); `'namzu.connector.server.name'` as a raw string literal | `scope.name: 'connector/mcp'` + `namzu.connector.server.id` (operator-configured) / `namzu.connector.server.name` (kept separate — the remote server's own self-reported name, which is untrusted input) |
| `packages/cli`'s `DoctorRegistry` | `component` | `scope.name: 'doctor'` — fixed in the same release specifically because `component` becoming inert would otherwise have silently dropped this logger's console bracket prefix with no alternative available to it |

No exported identifier is renamed or removed. `SCOPE_ATTRIBUTE` is a new export from `@namzu/sdk`'s root — additive. `ConnectorManagerConfig` gains one new *optional* `log?: Logger` field — additive, no existing caller needs to change. `RunContextFactory.buildLogger`'s config type widens to accept an optional `parentRunId` it did not read before — additive.

**Not included in this release, tracked as a follow-up:** the remaining ~35 SDK source files that still bind `component:` are unaffected — they behave exactly as before, and will migrate in a later release. The CI gate's `unnamespacedBindingCount` ratchet moves from 48 to 40 to reflect that this release is a partial migration, not the finished one.
