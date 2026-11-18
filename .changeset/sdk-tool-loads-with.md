---
'@namzu/sdk': minor
---

A tool can declare `loadsWith`, the names of tools that are needed right after it. When `search_tools` loads such a tool it loads those companions in the same call and names them in its result, so a deferred session no longer pays a second search and model request for them. `browser` and `browser_act` load together, and `task_create` loads `task_update`. Nothing breaks: a tool without `loadsWith` loads as before.
