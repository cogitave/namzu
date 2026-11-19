---
'@namzu/cli': patch
---

On Windows, starting the extension runner right after an update no longer opens an empty console window that stays open while the runner runs. The sign-in entry is now repaired before the runner is first started through it. An entry that still runs an earlier command is registered again, unless it was switched off in Windows.
