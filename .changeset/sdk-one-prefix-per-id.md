---
"@namzu/sdk": major
---

One prefix per id, and nothing is rewritten on read. The pre-0.2 `thd_` compatibility is removed whole: the `session/migration` module and its exports (`acceptLegacyContainerId`, `rejectLegacyContainerPrefix`, `DefaultFilesystemMigrator`, `readMarker`, `writeMarker`, the sinks and their types), the boot-time filesystem re-layout `query()` ran on every first call, `RunContextFactory.ensureMigrated`, the `namzu.migration.completed` boot event, and the `prj_legacy_` form in `ProjectIdSchema`. A run state or session record whose topic id carries `thd_` now throws `RetiredIdPrefixError` instead of being coerced to `top_`; records written before 0.2 must be opened by a 0.x namzu or abandoned. `UNKNOWN_TENANT_ID` is removed: a host names its tenant. `CreateSessionParams.id` lets a host create a session under an id it minted. The `parse*Id` functions are deprecated in favour of `as*Id`, which throw `InvalidIdError`.
