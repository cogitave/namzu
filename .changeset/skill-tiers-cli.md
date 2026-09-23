---
'@namzu/cli': minor
---

`SKILL.md` skills now reach the model on their own. Every session lists the usable skills in the prompt's skills manifest and mounts the `skill` tool, which the model calls to load one when a task matches its description; until now only plugin skills did, and a file skill needed `/skills <name>` or `exec --skills`. Skills are read from six tiers, the later shadowing the earlier: built-in (`skills/` in this package, empty for now), `~/.agents/skills`, `~/.namzu/skills`, `./skills`, `.agents/skills` from the checkout root down to the working directory, and `./.namzu/skills`. The manifest is capped at 2% of the context window or 4 KB, whichever is smaller; skills that do not fit are named in one line and stay loadable.

What may change for you:

- A model working in a folder with skills now sees them and may load one. To keep a skill away from the model, add `disable-model-invocation: true` (or `invocation: operator`) to its frontmatter, or name it in the new `skills.disabled` config list; `skills.builtin: false` leaves the built-in tier out.
- A skill whose `metadata.namzu-requires-tools` names a tool the session lacks is not offered.
- `namzu skills-json` can now report `"source": "system"` for a built-in skill, and leaves disabled skills out. A host that switches on `source` should accept the new value.
- `namzu skills` and `/skills list` show each skill's directory tier and the files it shadows; `namzu --format json skills` items gain `tier`, and `shadows`, `disabled`, `invocation` and `requiresTools` when they apply.
