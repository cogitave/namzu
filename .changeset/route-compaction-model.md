---
'@namzu/sdk': minor
---

`taskRouter` now routes something.

The compaction summary is the only model call a run makes that nobody asked for: it reads the older half of a transcript and writes a paraphrase, and it fires on exactly the long runs where the primary model costs the most. It was hardwired to that primary model. Meanwhile `taskRouter` had been accepted, schema-validated and threaded through four types since it was added, with `resolveTaskModel` exported and never called from anywhere — so a host who pointed compaction at a cheap model kept paying the expensive one, with nothing to indicate the setting was decoration.

`taskRouter: { compaction: 'a-small-model' }` now takes effect, falling back to `taskRouter.default` and then to the run's model.

The remaining keys are documented on `TaskRouterConfig` as **not consulted**, which is the point of the change as much as the wiring is. `coding`, `exploration`, `planning`, `verification` and `summarization` describe sub-agent routing; the supervisor already threads the config down to the agent factory, but nothing classifies a spawned task as exploration or coding, and inventing a classifier would put a wrong model behind a right-looking config. `advisory` is deliberately left alone because an advisor already carries its own `model`, and routing would override an explicit choice with a general one. An inert key is worse than an absent one — saying which is which converts a silent lie into a stated limit.
