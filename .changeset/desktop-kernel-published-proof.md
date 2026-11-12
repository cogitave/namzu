---
"@namzu/desktop": patch
---

The engine release started by a package publish no longer ends quietly when the npm registry is slow to show the new version. It now goes ahead when the release tag for that version is on main, or when the registry has it, and waits up to 25 minutes for the registry only when no tag is there. Nothing for an installed app to do.
