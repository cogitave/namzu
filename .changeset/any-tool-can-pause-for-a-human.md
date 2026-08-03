---
'@namzu/sdk': minor
---

Any tool can raise a durable pause

The pause-for-a-human machinery is durable and complete, and it was reachable from exactly four kernel-owned points: the plan gate, the tool-review gate, the iteration cadence, and the built-in question tool. A host-authored tool had no seam to it — the operations that most want their own confirmation with their own wording, a spend, an outbound post, a destructive migration, had to settle for the generic tool-review gate or hand-thread a recorder and a resume callback into a private builder, which nothing in `ToolContext` suggested was possible.

`context.requestPause({ name, prompt, options })` is that machinery behind one function. The pause is written as a real checkpoint, so it appears on every surface a tool-review park appears on and survives the process dying, and on resume the answer routes back **by name** — several tools pausing in one batch each get their own, and one call may pause more than once.

The outcome is `answered`, `unanswered`, or `aborted`. Silence is deliberately not a variant of `answered` with an empty selection: a tool that asks "may I charge this card" and reads silence as yes is worse than one that never asked, so the absence of an answer has its own shape and cannot be destructured into consent. An option id the tool never offered is dropped for the same reason.

`requestPause` is optional on the context, because a host calling a tool directly provides no route to a human.
