---
'@namzu/sdk': major
---

The six `Thread*` aliases are removed. 28.0.0 carried them deprecated; this is
the release that drops them.

| Removed | Use |
| --- | --- |
| `ThreadId` | `TopicId` |
| `ThreadManager` | `TopicManager` |
| `InMemoryThreadStore` | `InMemoryTopicStore` |
| `generateThreadId()` | `generateTopicId()` |
| `acceptLegacyThreadId()` | `acceptLegacyContainerId()` |
| `rejectLegacyPrefix()` | `rejectLegacyContainerPrefix()` |

Each was an identity binding to the name on the right, so the migration is a
rename and nothing else — no behaviour changes with it, and `instanceof` and
`===` held across the alias while it existed.

The two `Legacy` helpers are worth a sentence, because their names described
the wrong thing. They decide whether an id belongs to the pre-0.2.0 top-level
CONTAINER, which is what `thd_` means now; they were never about a Topic. The
replacements say container.

Nothing on disk changes. A `thd_`-prefixed id already migrates to
`prj_legacy_*` at read time and continues to.
