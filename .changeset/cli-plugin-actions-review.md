---
'@namzu/cli': minor
---

`namzu/plugins/plan` and `namzu/plugins/update` no longer cut what a plugin runs: a hook or server command is returned whole, and a plugin whose runnable text is over 2000 characters or whose list is over 100 rows is refused with a sentence pointing to the command line, so the consent view never hides a tail. `namzu/marketplaces/remove` now refuses, before writing anything, while a plugin from that marketplace is installed for another folder. Callers that read the truncated strings need no change; a plugin that was shown cut before is now refused.
