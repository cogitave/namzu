---
"@namzu/sdk": minor
---

Adds `TeamStore`, `TeammateBackend` and the team name rules (`@experimental`): the storage layer for named helpers that work beside the main conversation. It keeps a team's members in a locked, atomically written `config.json` under `<NAMZU_HOME>/teams/<team>/` (a name is reserved before its helper starts and handed back if starting fails; two processes asking for one name cannot both get it), one mailbox file per member that several processes may append to without losing an entry, and a sweep for the directories of teams whose lead process is gone. Nothing here starts a helper, and nothing existing changes; callers that do not import it are unaffected.
