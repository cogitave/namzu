---
'@namzu/sdk': minor
---

A step can put a skill in front of the model.

`PrepareStepResult.skills` renders the named skills into the same ephemeral trailing system message `system` already uses. A run's skills are fixed at `query()` time and rendered into the cached system prefix, so every skill a run might ever need is paid for on every single turn — and a phased agent rarely needs them all at once. Research wants the search skill, writing wants the style guide, and neither benefits from carrying the other.

Appending rather than rewriting is the point: the run's own prompt stays byte-stable, so the cached prefix survives, where folding a phase's skills into it would invalidate the cache every iteration.

It is **additive** to the run's skills, not a replacement. A skill a run always carries should not be removable by a step naming a different one — that would make every step's list a complete restatement, and a phase that forgot one would silently lose it.

**Sub-agents are deliberately not per-step.** A peer runtime resolves instructions, model, tools, skills and subagents from context at run time; this closes the fourth of those and states why the fifth stays out. Which agents `create_task` can reach is baked into that tool's input schema, so varying it per step would rebuild the tool catalogue every turn — a worse prompt-cache trade than moving tools around, for a narrowing a step can already express by withholding `create_task` through `activeTools`.
