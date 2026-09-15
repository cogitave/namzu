---
"@namzu/sandbox": minor
---

`SandboxProviderConfig` gains a real arm for `ACIStandbyPoolBackendConfig` (paired with the `ContainerSandboxLayout` it requires, same as the plain container arm). Previously the exported union only covered `ContainerBackendConfig`, `MicroVMBackendConfig` and `KubernetesBackendConfig`, so `createSandboxProvider({ backend: { tier: 'container', runtime: 'aci-standby-pool', … } })` did not type-check even though the backend was fully implemented and `pickBackend` already dispatched to it internally through two `as unknown as` casts. That call now type-checks with no cast.

**Minor, not patch:** this is a backward-compatible widening of an exported input type — every config that type-checked before still does, and the only change is that a config shape the runtime already accepted is now also accepted by the type checker. That is additive public surface (a new union arm a consumer's own type-level code can observe), not an implementation-only correction, so it does not qualify for patch under this repo's rule that patch is reserved for changes that leave the public surface untouched.

No runtime behavior changed: the ACI backend's construction, options and defaults are exactly what they were.
