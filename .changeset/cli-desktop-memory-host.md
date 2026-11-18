---
'@namzu/cli': minor
---

The desktop host gains `namzu/instructions/get` and `namzu/instructions/set` (the person's own `AGENTS.md` in the Namzu home, the file every conversation already loads; empty text removes it, a link in its place is refused, the text is limited to the 32,000 characters a conversation follows) and `namzu/memory/list`, `namzu/memory/read`, `namzu/memory/update` and `namzu/memory/delete` (the project's saved memories; an edit or a delete names the version that was listed and is refused with `changed` when the memory moved on since). They act on the person's home only, refuse Pals, and send nothing to a model. Both groups are optional in the desktop contract: an older host lacks them and Desktop shows no row. Nothing already written changes meaning.
