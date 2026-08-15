---
'@namzu/sdk': major
'@namzu/cli': major
---

The denormalized `threadId` field is renamed to `topicId` everywhere it appears
on an exported shape, and `SessionStore.listSessions` is renamed to
`listSessionsByTopic`. NZ-TOPIC-01 (a previous minor) renamed the *layer* to
Topic and left this field as the one place the retired word still surfaced on
every shape a consumer types against; this is that rename landing.

Mechanical edits for every consumer:

- `session.threadId` → `session.topicId` (same rename on `RunState`,
  `AgentTaskContext`, `BaseAgentConfig`, `CreateSessionParams`,
  `HandoffAssignment`, `RunPersistenceConfig`, `RunContextConfig`/`RunContext`,
  `QueryParams`, `RunStateScope`, `AgentIdentity`, and the CLI's
  `CliSessions`/`RunScope`)
- `store.createSession({ threadId, ... })` → `store.createSession({ topicId, ... })`
- `store.listSessions(id, tenantId)` → `store.listSessionsByTopic(id, tenantId)`

Not touched: the `thd_` id prefix, `ThreadId`/`generateThreadId`/
`ThreadManager`/`InMemoryThreadStore` (still `@deprecated` aliases from
NZ-TOPIC-01), and the `Thread*`-named error classes in `session/errors.ts`
(`ThreadClosedError`, `ThreadNotEmptyError`, `StaleThreadError`) — their
`details.threadId` field keeps its name too. Renaming those is a separate,
later change with its own deprecation window; this one is the FK field only.

No alias ships alongside `topicId` — `SessionStore` is an interface hosts
implement, and a required method or field cannot be added behind a deprecated
twin without every implementor already supplying it. NZ-TOPIC-01 already
carried one minor of warning for the vocabulary; this is the field itself
moving, and it has to move all at once.

**Records already on disk migrate on first read, no operator action.**
`session.json` bumps the shared `session-store` schema from v1 to v2; a
record written by any older release loads exactly as it did before and comes
back with `topicId` set from its `threadId`, both in-memory immediately and
(after the next write to that record) on disk. `project.json`,
`subsession.json`, `summary.json`, and `messages.jsonl` lines never carried
the field and the migration step leaves them untouched — verified directly,
not just by inspection: a naive unconditional version of this migration would
stamp a stray `topicId: undefined` onto every one of them, and that is
exactly what the new migration unit test rejects.

A `RunState` snapshot a host serialized under `RUN_STATE_VERSION: 1` is
coerced the same way by `parseRunState`. A snapshot written under the new
`RUN_STATE_VERSION: 2` and read by an SDK still on version 1 is refused with
`RunStateVersionError`, not partially restored — unchanged behavior, now
exercised against this specific case.
