---
'@namzu/sdk': minor
---

A `turn` placement, for state that changes during a run.

`static` is cached across turns and `dynamic` is part of the system prompt, so neither can carry a budget running down, a queue draining, or a policy that just moved: one serves the first iteration's value forever, and the other is read as a standing instruction rather than as a status.

`turn` is a third thing, not a looser `dynamic`. It rides the ephemeral trailing message that a step's guidance, its skills and the approval-policy notice already use — appended to the request, never pushed onto the run's history, gone the moment the request is sent. `PromptContributionContext.iteration` is present only for this placement, which is the type stating what the placement means: a contribution that needs to know which turn it is cannot be part of a prompt assembled once and cached.

The builder **refuses** to render `turn`, and its signature says so. In the system prompt it would be cached for the run or read as standing instruction, and either way the state it exists to report goes stale silently.

The cost is real and stated: every iteration pays for it in tokens, and it lands after the cached prefix so it cannot be cached. The approval-policy notice is the shape to copy — text only when something actually changed, `null` on every other turn.

The prompt cache hashes contribution ids and placements, not rendered text: hashing output would run every contribution twice per request for a value the cache exists to avoid computing, and a contributor whose output changes while its id does not is exactly the one that must declare `dynamic` or `turn`. The static-segment hash folds in `static` contributions only, so a `turn` contributor coming or going does not invalidate a prefix it does not describe.
