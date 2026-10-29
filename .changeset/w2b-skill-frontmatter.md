---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A skill can now say when the model should use it and run as a delegated agent. `when_to_use` is shown after the description in the skills manifest and in the `skill` tool's listing. `context: fork` makes the `skill` tool hand the skill to the turn's `Agent` tool, with `agent`, `model`, `effort` and `background` as that agent's type, model, reasoning effort and background flag, and return its report; the `skill` tool gains an optional `args` string for what to apply the skill to. A turn with no `Agent` tool loads the skill inline and says so. An inline skill still runs on the turn's own model. These keys are read leniently: a value that cannot be used, or one written as a block scalar or list, leaves the key out and the skill still loads. New exports: `skillModelDescription`, `SKILL_FRONTMATTER_TOLERATED_KEYS`, the `tolerates` option of `parseFrontmatter`, and the matching optional `SkillMetadata` fields. A skill that already sets one of these keys for another tool now gets the behaviour; remove the key to keep the old one.
