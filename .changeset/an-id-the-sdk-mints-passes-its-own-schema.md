---
'@namzu/sdk': major
---

An id the SDK mints passes the schema the SDK exports.

`ProjectIdSchema` was `/^prj_[a-z0-9]+$/`. The v0.2.0 filesystem migration
mints `prj_legacy_<suffix>`. So the SDK's own exported validator rejected every
project it had itself written to disk during a migration — a host that
validated an inbound project id, which is the only reason the schema is
exported, answered "Invalid project ID format" for its own data, with nothing
saying the id had come from the SDK.

The schema now accepts the two shapes the SDK mints and no others:
`prj_<12 lowercase alphanumerics>` from `generateProjectId()`, and
`prj_legacy_<suffix>` from the migration. It is deliberately narrower than the
`ProjectId` type, which is `prj_${string}`; a host that supplies its own
`SessionStore` and mints its own ids should validate with its own schema.

**Breaking:** the migration now refuses a legacy `thd_*` folder whose name is
not a thread id, where it previously migrated it. The migration is the one
place a project id is built from data rather than generated, and a folder named
`thd_Not An Id` produced `prj_legacy_Not An Id` — structurally a `ProjectId`,
accepted by no validator, and thereafter a directory name in the new layout.
`DefaultFilesystemMigrator.migrate` throws `FilesystemMigrationError` with
`op: 'validate_thread_id'` and the offending path.

If your store root holds such a folder, rename it to `thd_` plus lowercase
alphanumerics before upgrading, or move it aside; the migration is idempotent
and re-running it after the rename completes normally. Folders created by the
SDK are always of that shape, so a store the SDK wrote is unaffected.

It refuses rather than skipping the folder. Skipping would leave that thread's
runs on disk and unaddressable, write the completion marker anyway, and return
`kind: 'migrated'` with the thread absent from the list.

Also documented, not changed: a `projectId` that `runAgent` generates names no
`Project` record — it takes no store and creates nothing. Carrying one into a
store-backed `AgentManager` is refused at the first delegation with
`Project <id> not found for tenant <id> — spawn rejected`, which is the
enforcement site behaving correctly, since delegation limits live on the
project. A run that has to delegate should be given the id from
`store.createProject()`. The `AgentIdentity` doc now says so.
