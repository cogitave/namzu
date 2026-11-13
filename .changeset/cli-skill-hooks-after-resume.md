---
'@namzu/cli': minor
---

A skill that carries hooks gets them back when the conversation is continued (`--continue`, `--resume`, the picker, a fork, a branch from an earlier prompt, a model change). They are attached again before the first tool call from the skill file as it reads now, under the same guard rule, switches and trust. If the file is gone, no longer loads or its folder is no longer trusted, they are not attached and you and the model are told which skill and why. The skill's result no longer says its hooks last "until cleared or resumed". Skills run by name (`/skills`, `--skills`) are not restored. Needs `@namzu/sdk` with this change.
