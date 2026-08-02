---
'@namzu/sdk': major
---

**Breaking:** three public types that promised behaviour the runtime does
not have are removed.

A public type that describes an absent capability is a worse defect than an
absent type. It reads as a feature, gets designed around, and the discovery
that it does nothing happens at runtime — usually in the one code path
nobody exercised until production.

- **`PluginHookResult`'s `{ action: 'resume' }`** — declared as a hook
  outcome and rejected with "unsupported action" at every one of its three
  consumers: the lifecycle-event applier, the `pre_tool_use` path and the
  `post_tool_use` path. A plugin author reading the union had every reason
  to think a hook could resume something. Nothing could.
- **`ConcurrencyMode`** (`'throw' | 'queue'`) — no API accepts it, nothing
  calls the lock it was meant to configure, and the `queue` half describes
  a mode that was never built. It promised a choice about concurrent
  invocation where there is exactly one behaviour.
- **`ToolPermissionPolicy`** and `ToolsetPolicy.permissionPolicy` — written
  once with a constant `'default'` and read by no runtime code. A host
  setting `'always_ask'` on a toolset got no prompt and no error.

Migration: nothing consumed any of them, so nothing should break. If your
code sets `permissionPolicy`, delete the field — it never did anything; the
verification gate (`allow_by_name`, `custom_pattern`, `target: 'args'`) is
the surface that actually decides. If a hook returns `{ action: 'resume' }`,
it was already throwing at every call site.

Kept, and documented instead of removed: `AgentManager.continueTask` /
`queueMessage` / `drainMessages`. The queue they maintain is read by
nothing in the iteration loop — the consumer that once drained it was
removed — so a caller who assumes `continueTask` reaches a running agent is
filling a buffer only `drainMessages` empties. That is now stated on the
interface, along with the two mid-run routes that DO work (feedback inside
a tool result; `prepareStep`'s `system` string). Deleting `drainMessages`
would have removed the only way a host can pick those messages up and left
the trap in place.
