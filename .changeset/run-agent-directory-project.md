---
"@namzu/sdk": major
---

`runAgent` no longer mints a new `projectId` for every call. When you pass no
`projectId`, it is the project of `workingDirectory` (default
`process.cwd()`): `ensureProject` mints one UUIDv7 the first time a directory
is used, writes it to `<NAMZU_HOME>/projects/<slug>/project.json`, and every
later call in that directory adopts it. Two processes that start in a new
directory at the same moment get the same id. Every session started in one
directory is filed under one Project, in one `projects/<slug>/` tree.

**What changes for you.** Two `runAgent` calls in the same directory now
return the same `identity.projectId`. `sessionId`, `topicId` and `tenantId`
are still generated per call, so the calls stay separate conversations. To get
the old behaviour, pass `projectId: generateProjectId()` on each call. An
explicit `projectId` always wins.
