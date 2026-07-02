---
'@namzu/sdk': minor
---

Add lazy provider registration: `ProviderRegistry.registerLazy(type, loader, options?)` plus async construction via `ProviderRegistry.createAsync()` / `createProviderAsync()`.

Hosts that must not bundle every provider client into every entrypoint can now register a dynamic-import loader instead of an eagerly imported class — no more hand-rolled construction switches outside the registry. Registration never invokes the loader; the first `createAsync()` awaits it, validates the resolved `{ create }` module, and caches the factory. Concurrent first-creates share a single in-flight load, and only success is cached: a rejected load surfaces as the new `LazyProviderLoadError` (original failure on `cause`) and the next create retries.

Capabilities integrate with capability negotiation: an optional `options.capabilities` hint lets `getCapabilities(type)` answer before the provider is loaded (no hint ⇒ permissive default), the loaded module's declared capabilities replace the hint, and the constructed instance's own `LLMProvider.capabilities` remain what the query runtime negotiates against.

Lazy types are deliberately not constructible through the sync `create()` / `createProvider()` — those throw the new `LazyProviderSyncCreateError` deterministically so sync behavior never depends on load timing. Existing eager `register()` / `create()` behavior is unchanged.
