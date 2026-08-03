---
'@namzu/sdk': minor
---

Deprecate `ToolCatalogSurface` and `ToolsetPolicy.surfaces`.

Neither does anything. No code constructs a member of the union, and nothing reads the field that carries it — setting `surfaces` on a toolset policy has no effect and never had one.

It is also the wrong axis. Which tools a run may use is already expressible four ways, and all of them are per-run and dynamic where this is fixed at definition time: `allowedTools` on the query, `ToolAvailability` (`active` / `deferred` / `suspended`) with mid-run activation through tool search, `runtimeToolOverrides`, and capability negotiation stripping tools a driver cannot carry. `allowedTools` says the same thing, per run.

The member names — `chat`, `managed-agent`, `worker` — encode deployment shapes this kernel does not own, which is the deeper reason not to keep them. A host's surfaces are the host's to name.

Deprecated rather than removed because both are reachable from the published typings, so removing them is a breaking change. They go in the next major. This is the deprecation cycle the release policy asks for: a version where the code still compiles and warns.
