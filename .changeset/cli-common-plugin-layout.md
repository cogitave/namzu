---
'@namzu/cli': minor
---

Plugins written in the common plugin layout now load from `.namzu/plugins`, `~/.namzu/plugins` and `--plugin-dir` with no `plugin.json`: their skills, commands and agents are found without being listed, a command or agent may be one file, `${NAMZU_PLUGIN_ROOT}` in their text is replaced by the plugin's folder, `/<plugin>:<command>` is accepted next to `/<plugin>__<command>`, and what Namzu has no place for (themes, settings, a remote server that is not started yet) is said once at launch. `namzu plugin validate` reads the layout and its `--json` report gains an optional `layout` object. Nothing existing breaks. Note the raised plugin limits: 64 skills, 16 servers, and 64 command and agent entries per plugin (they were 20, 5 and 10), so a plugin that used to be refused for size may now load. Remote servers a plugin lists are read and shown, not started.
