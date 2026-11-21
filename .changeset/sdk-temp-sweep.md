---
"@namzu/sdk": minor
---

Adds `sweepPrivateTempRoot` (with `TEMP_SWEEP_MAX_AGE_MS`, `TEMP_SWEEP_EVERY_MS`, `TEMP_SWEEP_STAMP`, `HOOK_ENV_OWNER_FILE`) to clear old session scratch folders, dead `hook-env*` folders and dangling `s-*` names from Namzu's private temp folder. A hook-env folder now records an `owner.json` with its process id; nothing to do for existing callers.

A hook folder whose owning process reads as gone is now also kept until nothing in it changed for ten minutes, so a process in another pid namespace sharing the temp folder keeps its folder.
