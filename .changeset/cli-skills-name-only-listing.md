---
'@namzu/cli': patch
---

A skill set to name-only in `/skills` is now listed to the model by name alone in the per-turn skill listing too; before, that listing still carried its description. The `/skills` screen also takes a lower layer's `skills.overrides` into account when deciding whether a change needs a key in the local file, so putting a skill back to what the user or shared config gives no longer reports a change that does not take effect.
