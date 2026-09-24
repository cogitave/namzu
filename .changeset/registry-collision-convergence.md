---
"@namzu/sdk": major
---

Every registry now throws on a duplicate id by default instead of silently overwriting or skipping. `ManagedRegistry`'s own default flips from warn-and-overwrite to throw (`RegistryCollisionError`), and the same convergence applies to registries that were not built on it: `AdvisorRegistry.register` now throws `AdvisorCollisionError` instead of overwriting in silence; `SkillRegistry.add` now throws `SkillCollisionError` instead of overwriting in silence; `EnvironmentConnectorManager.registerEnvironment` and `TenantConnectorManager.registerTenant` now throw `EnvironmentCollisionError`/`TenantCollisionError` instead of logging a warning and silently keeping the original. `AgentRegistry`, `ConnectorRegistry` and `HostCommandRegistry` (built on `ManagedRegistry` with no registry-specific override) throw by the same default flip.

`ToolRegistry` and `PluginRegistry` are named exceptions and keep today's overwrite behaviour: pass `onCollision: 'warn-overwrite'` explicitly if you build your own `ManagedRegistry` subclass and need the old default. A single call that needs to replace one entry on a registry that now throws calls the new `ManagedRegistry.replace(id, item)` instead — see `docs/sdk/registries.md`.

Every SDK `*CollisionError` (`ToolNameCollisionError`, `HostCommandNameCollisionError`, `ConfigNamespaceCollisionError`, `PromptContributionCollisionError`, `ReadModelCollisionError`, `InvariantNameCollisionError`, `ProbeNameCollisionError`, `DuplicateProviderError`, plus the four new ones above) now extends the new `RegistryCollisionError` base class; names, messages and fields are unchanged, and a catch block naming the concrete class still works. A catch that wants "some registry collided" without naming every class can catch `RegistryCollisionError`.

If you called `register`/`registerEnvironment`/`registerTenant`/`SkillRegistry.add` a second time under the same id expecting a silent overwrite or a silent skip, that call now throws. Call `unregister` first, or (on a registry built on `ManagedRegistry`) call the new `replace(id, item)` instead.
