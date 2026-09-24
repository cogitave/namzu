---
type: Reference
title: Registry collisions
description: One collision policy, one base error class, and which registry chose which policy and why.
resource: packages/sdk/src/registry/collision.ts
tags: [sdk, registry]
status: stable
---

# Registry collisions

Every registry in the SDK — tool, agent, plugin, connector, provider, config
namespace, invariant, probe, prompt contribution, read model, advisor,
skill, tenant, environment, host command — answers the same question:
what happens when a second item claims an id the registry already holds?
Before this page, five different answers coexisted, undocumented, across
roughly fifteen registries. `registry/collision.ts` gives the concept one
vocabulary; every registry now converges on the same default.

## The policy

`RegistryCollisionPolicy` is `'throw' | 'warn-overwrite' | 'warn-skip'`.
`ManagedRegistry`'s own default is `'throw'`: a second registration under a
live id is refused with a `RegistryCollisionError` naming the registry
and the id, and the original stays in place. That is the right default
because a duplicate id is, for almost every registry here, a bug — two
modules picking the same name, or one registering itself twice — not a
supersession a caller intended.

`RegistryCollisionError` is the base class every domain-specific
`*CollisionError` now extends (`ToolNameCollisionError`,
`HostCommandNameCollisionError`, `ConfigNamespaceCollisionError`,
`PromptContributionCollisionError`, `ReadModelCollisionError`,
`InvariantNameCollisionError`, `ProbeNameCollisionError`,
`DuplicateProviderError`, `AdvisorCollisionError`, `SkillCollisionError`,
`EnvironmentCollisionError`, `TenantCollisionError`). A host that wants to
catch "some registry collided" without naming every concrete class catches
`RegistryCollisionError`; a host that wants the specific one — to decide
between skip, rename or refuse to boot — catches the named subclass exactly
as before. Names, messages and fields are unchanged from before this file
existed; only the shared base and the default policy are new.

## Where a caller means to replace, not collide

Two registries opt out of `'throw'` as their own default, because their own
callers are documented and tested as legitimately re-registering the same
id:

- **`ToolRegistry`** passes `onCollision: 'warn-overwrite'` explicitly. It is
  scheduled for removal — tools will enter only through toolsets, resolved
  by a runtime-owned tool manager — and nothing about tool registration
  changes ahead of that redesign.
- **`PluginRegistry`** passes `onCollision: 'warn-overwrite'` explicitly.
  `PluginLifecycleManager` re-registers the same plugin id on every status
  transition (installed → enabled → disabled, or → error), and the registry
  is a public projection a host may also overwrite directly — executable
  contribution ownership, not this registry, is what a forged status cannot
  fool.

Every other registry — `AgentRegistry`, `ConnectorRegistry`,
`HostCommandRegistry`, `AdvisorRegistry`, `SkillRegistry.add`, the connector
managers' `registerEnvironment`/`registerTenant` — throws by default. A
single call that genuinely needs to replace one entry on a `'throw'`
registry calls `ManagedRegistry.replace(id, item)` instead of changing the
registry's policy: `replace` always overwrites, regardless of
`onCollision`, and exists for exactly the caller that means it — a test that
mutates a registered connector definition to prove a manager captured a
detached snapshot, for instance, rather than a live reference.

## `warn-skip`

The third policy, `'warn-skip'`, logs and keeps the existing item, discarding
the one being registered. It is right when the FIRST registration should win
and a host still wants to know a second tried — a plugin whose defaults must
not shadow a user's override — but no in-tree registry defaults to it today;
a registry opts in the same way `ToolRegistry` and `PluginRegistry` opt into
`'warn-overwrite'`, via `onCollision` in its constructor.
