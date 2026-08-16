---
'@namzu/sdk': patch
---

Internal directory rename: `src/router/` is now `src/model-router/`. No exported name, signature or behaviour changes — `resolveTaskModel` is imported from the package root as before.

`router/` said nothing about what it routes, and the SDK has two unrelated routing concepts: this one picks a MODEL for a task, while `types/router/` holds `TaskRouterConfig`/`TaskType`. Those two sat next to each other under names a reader could not tell apart. `types/router/` stays where it is — it is the config shape, filed with the other types.
