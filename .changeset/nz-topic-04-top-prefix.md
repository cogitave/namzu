---
'@namzu/sdk': major
'@namzu/cli': major
---

Topic ids now begin `top_` instead of `thd_`. From this release `thd_` means only the pre-0.2.0 top-level container that `session/migration/id-prefix.ts` and `session/migration/filesystem.ts` already coerce to `prj_legacy_*` — the Topic layer's own id no longer shares that prefix, closing the ambiguity where two unrelated things wore one prefix and only a path depth told them apart.

**What breaks, and what to do:**

- **A minted topic id is now `top_*`.** `generateTopicId()` returns `top_…`; the `TopicId` type is `` `top_${string}` ``. Code that pattern-matches `thd_` on a live topic id, or that pins a literal, needs updating. Code that pattern-matches `thd_` on the *legacy container* is unaffected and should stay.
- **`acceptLegacyThreadId` → `acceptLegacyContainerId`** and **`rejectLegacyPrefix` → `rejectLegacyContainerPrefix`.** Behaviour is identical (`acceptLegacyContainerId` also takes a new optional third `windowOpen` argument, defaulting to the existing `WINDOW_OPEN`). The old names remain as `@deprecated` aliases — your code still compiles and warns. Renamed because "Thread" stopped describing what these accept: the pre-0.2.0 container, not the Topic layer.

**Nothing is removed in this release.** `ThreadId`, `ThreadManager`, `InMemoryThreadStore`, `generateThreadId`, `acceptLegacyThreadId` and `rejectLegacyPrefix` are all still exported and all now carry `@deprecated`. Removal is a later major.

That is deliberate, and it corrects a mistake this change was originally planned to make. The rename of Thread→Topic marked those names deprecated in source, but that work has never been published: the registry is still on 27.1.0, and its changeset is still unconsumed. So on every version a consumer can actually install, `ThreadManager` is not a deprecated alias — it is the *only* name, and ordinary code uses it. Deleting it here would have moved a consumer from "works, no warning" straight to "gone", which is a rename with no alias wearing a major's clothes. This release is the first one that can carry the warning; the next major may remove them.

Note that `ThreadId` now resolves to `` `top_${string}` `` rather than `` `thd_${string}` ``, and `generateThreadId` mints `top_`. An alias that kept the old prefix would hand two different id spaces to one program depending on which name a file happened to import.

**Existing records migrate on first read; no operator action.** A `session.json` written with `topicId: "thd_x"` is rewritten to `topicId: "top_x"` when `DiskSessionStore` reads it, and durably on the next write-back, via a new `session-store` schema step (2→3) chained after the existing `threadId`→`topicId` field-rename step for any record still at v1. A serialized `RunState` snapshot migrates the same way through `parseRunState` (`RUN_STATE_VERSION` 2→3).

**No topic-directory rewriter is included, and none is owed.** There is no disk-backed `TopicStore` — `store/topic/memory.ts` is the only implementation — so no `.namzu/…/threads/<thd_x>/` directory has ever been written by a shipped build. The only on-disk artifact naming a topic is the denormalized `topicId` field covered above.
