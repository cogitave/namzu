---
'@namzu/sdk': minor
---

A plugin can now declare configuration an operator retunes while the run is live.

`config/runtime.ts` is one schema parsed once into a frozen object, and nothing
in that directory watches, subscribes or changes — so a plugin had no way to
expose a section of its own, and retuning one knob meant rebuilding the config
and restarting whatever had consumed it.

`ConfigRegistry.register(namespace, schema, { base })` returns a `ConfigScope<T>`
with `get()`, `update(patch)` and `watch(listener)`. Resolution is schema
defaults, then the plugin's base, then the operator's persisted override, the
whole thing parsed — so an override written against an older shape is refused at
registration rather than surfacing wherever it happened to be read. An invalid
patch throws, leaves the previous value in place, and fires no watcher.
`registry.scope(runId)` prefixes store keys so two concurrent runs cannot retune
each other while still sharing one `ConfigOverrideStore`
(`InMemoryConfigOverrideStore` is the default; `DiskConfigOverrideStore` persists
to one JSON file).

The driver ships with it: `MCPReconnectSupervisor` now takes a
`MCPReconnectPolicySource` — a function it calls at every decision point rather
than a value it captures at construction — and `attachMCPServer` registers each
server's policy under `mcp.<name>`. Raising `maxAttempts` mid-outage takes effect
on the next retry instead of on the next process.

Nothing existing changes shape: `MCPReconnectSupervisor` was not previously
exported, and a live seam that only resolved once would be the frozen object
again with more ceremony, which is why `get()` is a call.
