---
"@namzu/cli": patch
---

Saving a skill no longer follows a symbolic link. A project skill folder linked to your own `~/.namzu/skills/<name>` used to be overwritten by "Save to this project"; now any link below the working folder (project) or the skills folder (user), or a real path that leaves it, refuses the save and nothing is written. An existing skill is matched by real path, so such a link shows as the file it would overwrite. The confirmation warns when the body holds shell commands (`` !`cmd` `` or a fence opened with a bang) that run every time the skill loads, and a path on another drive is shown in full instead of behind a `.\` prefix. The Desktop browser-window card is drawn whatever the product is called in the question text.
