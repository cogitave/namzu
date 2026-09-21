---
"@namzu/sdk": major
---

`runAgent` no longer mints a new `projectId` for every call. When you pass no
`projectId`, it is derived from `workingDirectory` (default `process.cwd()`)
by the new `projectIdForDirectory`, a name-based UUID over the canonical path.
Every run in one directory is now filed under one Project. The durable layout,
`<root>/projects/<projectId>/sessions/…`, grows one tree per directory instead
of one per call, which was one tree per run for a batch of runs in one
directory.

**What changes for you.** Two `runAgent` calls in the same directory now
return the same `identity.projectId`. `sessionId`, `topicId` and `tenantId` are
still generated per call, so runs stay separate conversations. To get the old
behaviour, pass `projectId: generateProjectId()` on each call. To pin a
Project regardless of directory, pass one explicitly; an explicit `projectId`
always wins.

New: `projectIdForDirectory(directory: string): ProjectId`.
