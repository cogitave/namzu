---
'@namzu/sdk': minor
---

A delegation can now narrow the child it spawns.

`SendMessageOptions` and `CreateTaskOptions` take `toolScope: { deny }` and
`personaOverride`; `BaseAgentConfig` takes `allowedTools`, `deniedTools` and
`persona`. A supervisor handing out a read-only subtask could not say so
before — the child ran with everything its definition granted, so a research
delegation given to an agent that also holds `write` and `bash` held them
too.

`toolScope` is deny-only on purpose. The delegating side does not know what
the child has, and enumerating an agent's whole tool set in order to remove
one from it pins that list against an agent that later gains a tool —
silently, and in the direction of more access. Denial is therefore
subtractive: it applies on top of whatever the child would otherwise have,
composes with a `deniedTools` the agent's own definition set, and a name the
run never had is a no-op rather than an error.

The narrowing is enforced rather than presentational. The denied tool is
absent from the request AND rejected if the model calls it by name, so this
is a restriction rather than a suggestion. Nothing changes for a caller that
passes neither option.
