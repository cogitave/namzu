---
'@namzu/cli': minor
---

New deferred tools `get_settings` and `set_setting` in Desktop conversations and the terminal app: the model reads a short list of safe settings and, only after you say yes on a card or prompt that shows the setting's name and the old and new value, changes one. A standing yes, bypass mode and auto mode never answer it; permissions, the sandbox, the browser, sites, tool servers, hooks, plugins, computer use, models, keys, telemetry and updates are refused. New Settings row *Let Namzu change settings* (`agentSettings`, default on; your own or the managed file only, a project file's value is ignored). To keep the old tool listing, set `agentSettings: false`.
