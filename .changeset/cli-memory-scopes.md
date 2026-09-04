---
"@namzu/cli": major
---

Memory has a project scope. `#note` and `/memory <text>` now append to `<project>/.namzu/MEMORY.md`, not to `~/.namzu/MEMORY.md`; `/memory --user <text>` writes the user file. Every turn is given the project file, the user memory file and `USER.md`, each capped at 8,000 characters with a line naming what was left out. A workflow that relied on `#note` reaching every project should use `--user`.
