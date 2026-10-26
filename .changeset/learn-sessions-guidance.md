---
"@namzu/cli": minor
---

`namzu learn --sessions <module> --trust` now starts from the failures your conversations in this folder kept and needs no agent: the module you supply generates and evaluates a candidate, Namzu runs the independent check and the confirmation, and only the exact revision that passed becomes this project's guidance. New conversations in that folder then start with the active guidance as advice (it grants no permission and runs nothing; ephemeral conversations skip it). Nothing runs it for you, and a module is still required. Recorded failure excerpts also mask drive-letter and network paths. Without `--sessions` nothing changes. If you do not want conversations here to use learned guidance, do not run `namzu learn --sessions`; delete `learning/guidance` under the project's state directory to remove it.
