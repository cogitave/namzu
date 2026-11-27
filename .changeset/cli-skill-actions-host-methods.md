---
'@namzu/cli': minor
---

The desktop host answers four new methods for adding, making and removing skills from a Customize page: `namzu/skills/stage` (reads and checks chosen files and folders, writes nothing, keeps them in memory for ten minutes), `namzu/skills/install`, `namzu/skills/create` and `namzu/skills/remove` (moves to backups), under the optional group `skillsManage`. `namzu/mcp/save-user-server` also takes `headers` for an address: each value must be an environment reference such as `${EXAMPLE_TOKEN}`, and a literal value is refused. Nothing existing changes; a program that does not call these needs no action.
