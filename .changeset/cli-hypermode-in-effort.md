---
'@namzu/cli': minor
---

Hypermode is now an option of the effort command and picker instead of a row in Settings. `/effort high hypermode on` and `/effort hypermode off` work at any level, apply to this conversation only, are never saved by a command or the picker, and show in the footer as `effort high · hypermode`. `hypermode: true` in the config file still starts new conversations in it, and `/hypermode` still works. If you changed hypermode in Settings before, set `hypermode` in the config file instead; its Settings row is gone.

Hypermode is refused while dynamic workflows are off, with one sentence pointing to Settings, and a saved `hypermode: true` does not start a conversation in it then. New `workflow.keywordTrigger` (Settings, Agent, *Keyword trigger*, default on) decides whether typing `hypermode` or `workflow` in a message opts that message in. *Preferred workflow size* is now *Dynamic workflow size* and, with the two workflow caps, is shown only while *Dynamic workflows* is on; saved values are kept.
