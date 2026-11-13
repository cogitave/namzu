---
'@namzu/cli': minor
---

`namzu hooks [--cwd <path>] [--json]` says what runs by itself in a folder: every hook from your config files, the folder's files, plugins, skills and agent files, with its event (both spellings), matcher and `if`, what it starts, where it comes from, whether it is on (`runs`, `off` with the switch that turned it off, `attaches when used`, or `not loaded` with the reason), what the readers could not load, and where each switch was set. It reads files as text and never runs or imports anything of the folder (a plugin's JavaScript module is named, not loaded), so it can be asked about a folder you have not trusted: that folder's own hooks are listed as not loaded, with what would start once it is trusted. With `--json` it prints the same facts as one JSON value for a script.

The desktop host (`namzu acp --desktop`) answers the same question as `namzu/hooks/list`, a new optional method an application can ask for; a host without it simply does not list it among its extensions. The answer is versioned (`version: 1`) and only ever grows by added fields. Nothing you use today changes: no key, event, field or default is removed or renamed, and `/hooks`, `namzu doctor` and the trust prompt say what they said. Nothing to do when upgrading.
