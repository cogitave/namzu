---
"@namzu/sdk": minor
---

Unblock BYO-provider use of `AgentManager.spawn` and capture the full 0.2.x → 0.3.0 window.

**Bug Fixes**

- `AgentManager.sendMessage` no longer requires both `configBuilder` AND `factoryOptions` together. The configBuilder now runs whenever it is registered; `factoryOptions` defaults to `{}` when absent. This closes the silent crash path that consumers following README's "getting started" install hit with Bedrock (ERESOLVE → bare-config → ReactiveAgent null access).
- `AgentFactoryOptions.apiKey` is now optional. BYO-provider flows (Bedrock IAM, custom `ProviderRegistry.create(...)`) no longer need to fabricate a meaningless empty `apiKey` just to satisfy the type.

**Breaking Changes carried over from the 0.2.x → 0.3.0 window**

- `feat(sdk)!: propagate threadId through runtime + wire archive gate` — childConfig now receives `sessionId/threadId/projectId/tenantId` automatically from the parent context (stamped by AgentManager after configBuilder returns). configBuilder implementations that previously emitted these fields manually are unaffected; implementations relying on the old 0.2.0 three-ID triple (`sessionId/projectId/tenantId` without `threadId`) will now see `threadId` populated on the child config.

**Other**

- `knip` integrated as the dead-code detector (dev-only, no runtime surface change).
- `ThreadManager.archive`/`delete` primitives added to `SessionStore`; wire-side `thread_id` renamed during the Thread→Project wire refactor (internal rename).

See commits since `sdk-v0.2.0` for the full list; this changeset captures the visible-to-consumer summary.
