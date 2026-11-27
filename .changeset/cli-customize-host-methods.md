---
'@namzu/cli': minor
---

The desktop host answers three new methods for a Customize page: `namzu/skills/catalog` (every skill with its place, on, name-only, user-only or off state, update time, file count and use), `namzu/skills/files` and `namzu/skills/read_file` (the files of one skill's folder and one text file of it, never leaving the folder). `namzu/plugins/list` entries also carry `skills`, `servers`, `author` and `updatedAt`, read from the manifest without running the plugin. Nothing existing changes; a program that does not call the new methods needs no action.
