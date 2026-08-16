---
'@namzu/sdk': patch
'@namzu/cli': patch
'@namzu/sandbox': patch
---

Strings that were asserted into ids now go through the checked constructors, and three defects the assertions were hiding are fixed.

**A docker sandbox's id had the wrong prefix.** `SandboxId` is `` `sbx_${string}` ``; `@namzu/sandbox`'s docker backend minted `sandbox_...` and an `as SandboxId` was the only reason that compiled. Every docker sandbox in the tree carried an id its own type says is impossible — the ACI backend already minted `sbx_`. Both now mint through `asSandboxId`, which is the call that would have caught it. **The container name derives from this** (`namzu-sandbox-${id}`), so a container started by this release is named differently from one an older build started. Nothing matches on the old spelling — teardown computes the name from the id it just minted, in the same process — but it is visible in `docker ps`, and any external tooling that pattern-matched `namzu-sandbox-sandbox_` needs updating.

**A corrupt migration marker was honoured instead of refused.** `readMarker`'s shape check validated the envelope — `version`, `at`, and that `migratedThreads` is an array — and never looked inside the array. `{"migratedThreads":[null]}` therefore parsed cleanly and produced an entry whose `newProjectId` was `undefined` wearing a `ProjectId` annotation, which then reached a path join. Each element is now checked, and a bad one returns `null` — which is exactly what this function already promised to do about corruption, so the caller re-runs the migration rather than trusting it.

**`namzu drain` accepted a mistyped scope flag.** `--tenant`, `--project` and `--session` were asserted straight into their id types, so `--tenant prj_a` reached the store and listed nothing — and "no runs" is the same output as a scope that really is empty, which made the typo invisible. Each flag is now prefix-checked, and the refusal names the prefix it wanted, in the same operator-readable shape the command's other refusals use.

**Model-authored ids are checked before they become store keys.** `read_memory`, `task_update` and the RAG tool took an id straight from the model's tool input and asserted it. A malformed one read back as "not found", telling the model its record had disappeared rather than that it named the wrong thing. All three now refuse with `InvalidIdError`, whose message says which prefix was expected.

Nothing here changes an exported type, a signature or a default. Sites where a cast is still correct — a value already guarded by an explicit prefix check, an id minted by a service outside this repo, a sentinel the type cannot express — keep the cast and now carry the reason next to it.
