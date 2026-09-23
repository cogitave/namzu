---
'@namzu/sdk': minor
---

`loadSkill` (and so `SkillRegistry`) skips frontmatter keys it does not read, whatever YAML they are written in, instead of refusing the whole file: a `SKILL.md` carrying `argument-hint: [file]` or a `hooks:` block with a list now loads with those fields ignored. The keys it does read are still parsed strictly; they are exported as `SKILL_FRONTMATTER_KEYS`. `disable-model-invocation: true` now reads as `invocation: operator`; a value other than `true` or `false`, or one that contradicts an explicit `invocation`, refuses the file. `parseFrontmatter` takes an optional third argument, `{ readsKey }`, to get the same leniency for a caller's own vocabulary; without it every key is parsed and refused as before. A skill file that used to be refused over an unread key now loads, and one with `disable-model-invocation: true` is no longer offered to the model — nothing else changes.
