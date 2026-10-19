---
"@namzu/cli": minor
"@namzu/sdk": minor
---

"Yes, and don't ask again" now lasts. The answer used to hold for the session only; it is now saved in `namzu.config.local.json` next to the project's `namzu.config.json`, and the next session starts with it. The file is a new config layer over the project file, git-ignored (Namzu adds `**/namzu.config.local.json` to your global git ignore file the first time, unless git already ignores it), and read only where the project file is.

A command is remembered as its first two words and a star when the second word is a plain subcommand (`git commit *`, `npm run *`), and as the exact command otherwise. Shells, `env`, `xargs`, `sudo`, `timeout` and the other wrappers are never remembered as a prefix. A compound line gets one rule per command, up to five. The answer still never covers a sandbox escape, a path outside the roots, a protected path, a catastrophic removal, a rule's `ask` or a destructive call, and a deny in any layer beats it. To forget an answer, delete its line from `namzu.config.local.json`.

`namzu.config.local.json` is added to the SDK's protected paths, so a model write to it is asked about in every mode.
