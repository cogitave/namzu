---
'@namzu/sdk': minor
---

A plugin can ship hook entries (a command, an http address or a prompt), and a command started for one finds the plugin's own folder. Nothing existing changes and nothing has to be done to upgrade.

For a host that embeds the kernel: `PluginLifecycleManagerConfig.hooksFor` is called when a plugin is enabled and returns the hooks the host read for it; they are registered under the plugin's id, so disabling, uninstalling or a failed enable removes them with the plugin's other hooks, and `listHooks()` marks them `shell: true` so a host can list them apart from the plugin's JavaScript hooks. The manifest gains `hookEntries`, an events object written inline (kept as written; the host reads it), and a path in the manifest's `hooks` that ends in `.json` is now a file of entries and is no longer imported as a module (`isHookEntriesPath`); `hooks` is still a list of paths. `ShellHookOptions.plugin` (`{ root, dataDir }`) starts every command of those entries with `NAMZU_PLUGIN_ROOT` and `NAMZU_PLUGIN_DATA`, creates the data folder when a command first runs, and replaces `${NAMZU_PLUGIN_ROOT}` and `${NAMZU_PLUGIN_DATA}` in the command and arguments; a name ending in `_PLUGIN_ROOT` or `_PLUGIN_DATA` that the command refers to and nothing sets is given the folder (`MOVED_FOLDER_ENDINGS`, `substitutePluginFolders`, `isPluginFolderVariable`, `PluginFolders`).

One narrow change in what runs: a command with no plugin that refers to a variable ending in `_PLUGIN_ROOT` or `_PLUGIN_DATA` that is set nowhere is no longer started with an empty value; the run is reported as a hook that could not start and follows the entry's `onFailure`. If a command depended on such a variable being empty, give it a value with the entry's `env`.
