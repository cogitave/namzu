---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A plugin can now contribute slash commands and agents, and a plugin folder can be tried for one launch. In `plugin.json`, `commands` and `agents` list folders (relative to the plugin, no `..`) of markdown files: a command file works like one in `.namzu/commands/` and is named `/<plugin>__<file>`, an agent file works like one in `.namzu/agents/` and is named `<plugin>__<name>`; the user's and project's own files of the same name win. `/plugins` lists them. The SDK manifest type gains optional `commands` and `agents`, and `PluginLifecycleManager.install` takes an optional `authorityRoot` for a plugin folder outside both scope roots. `namzu --plugin-dir <folder>` (repeatable) loads that plugin for this launch without `plugins.enabled`; it runs the plugin's code, so name only folders you trust. A manifest that already carried `commands` or `agents` keys had them ignored; they now take effect, so remove them to keep the old behaviour.
