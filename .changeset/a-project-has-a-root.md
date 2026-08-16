---
'@namzu/sdk': minor
---

`Project` gains an optional `rootPath`: the canonical directory its work happens in. `CreateProjectParams` accepts one, `SessionStore` gains an optional `findProjectByRootPath(rootPath, tenantId)`, and `ProjectRootPathTakenError` is exported.

A host building a project switcher had nothing to bind a directory on disk to a durable cross-session record. No new noun was minted for this — `Project` is already the durable top-level container, with an id, a tenant, a status and a CAS counter, and it simply carried no path.

**Canonicalized through `realpath` before storage.** A path stored as typed makes `/tmp/p`, `/tmp/p/` and a symlink to it three records for one directory, and every uniqueness check passes while doing it. The lookup canonicalizes too, so a caller may pass whatever they have.

**A second project on the same canonical directory is refused, not deduplicated.** Returning the existing one looks friendlier and silently discards the `name` and `config` the caller passed — they asked to create something, and getting a different thing back with their arguments dropped is worse than an error. The error carries the existing `ProjectId`.

The lookup is tenant-scoped, with the tenant *in* the index key rather than filtered afterwards: two tenants may bind projects to the same path on one machine, and a path-only key would hand one of them the other's project.

`findProjectByRootPath` is optional. `SessionStore` is implemented by hosts, and a required method stops them compiling for a capability they never asked for.
