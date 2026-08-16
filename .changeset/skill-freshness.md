---
'@namzu/sdk': patch
---

An edited SKILL.md reaches the model without restarting the process.

`SkillRegistry.load` short-circuited on `existing.body`, so once a skill's body had been read it was cached for the life of the registry. That is tolerable for a one-shot run and wrong for a long-lived one — a skill is a file an author edits *while* the agent is running, which is the whole reason it is a file and not a constant.

One `stat` per lookup, comparing mtime **and** size. Not a hash — that means reading every skill on every lookup, which is the cost the cache exists to avoid — and not a watcher, which is a resource with a lifetime this registry has no teardown to hang one on. The limit is stated rather than hidden: an edit that changes neither size nor mtime, inside one timestamp tick, is not detected.

A skill whose SKILL.md was **deleted** is dropped rather than served from cache, and removed from the listing too, so a manifest and a lookup cannot disagree about whether it exists. An edit that makes the file invalid surfaces its error rather than quietly keeping the last good body.

Reloading keeps the name the skill was **registered** under, not the one now on disk — the plugin path files skills as `plugin__skill` while the file says `skill`, so taking the name off disk would silently un-namespace them. The same object is stored and returned, since caching one and returning another hands the caller the on-disk name and the registry the registered one.

`add()` takes no stamp: a fire-and-forget `stat` in a synchronous method would race the first `load`. Unstamped counts as changed, so the first lookup reads the file — one extra read, never a stale answer.
