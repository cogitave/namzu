---
'@namzu/sdk': minor
'@namzu/cli': patch
---

`Topic` becomes the primary name for the container between Project and Session.
Every exported `Thread*` name keeps working as a `@deprecated` alias.

The layer has always been a topic — its own docstring calls it a "Topic-level
container" — and `Thread` is the one word in this kernel's OS vocabulary that
already means something specific and different, for a thing that has no
execution and no state machine of its own.

Renamed, with identity aliases on the public surface: `TopicManager` /
`ThreadManager`, `InMemoryTopicStore` / `InMemoryThreadStore`,
`generateTopicId` / `generateThreadId`. `TopicId` is a type alias to the
unchanged `ThreadId`; both are still `` `thd_${string}` `` this release.

**Not in this release**, and deliberately: the `thd_` prefix itself, the
`threadId` field on persisted records, and `acceptLegacyThreadId` /
`rejectLegacyPrefix`. The last two belong to a DIFFERENT `thd_` — the
pre-0.2.0 top-level container the migration coerces to `prj_legacy_*` — and
merging the two meanings is the confusion this chain exists to end. The prefix
and the field each carry a data migration and land separately.
