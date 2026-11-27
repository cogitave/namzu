---
"@namzu/cli": minor
---

`namzu plugin install` installs a plugin from a folder, a `.zip` or `.plugin` archive, or a marketplace that is a folder or `.json` file on this computer, after showing everything in it that can run (hooks, local and remote servers, modules, scripts, pre-approved tools) and a digest of it. Accept with a typed yes, `--yes`, or `--accept-surface <sha256>`; with no terminal and neither flag it prints the preview and exits 75 and installs nothing. New commands: `plugin marketplace add|list|remove`, `plugin install`, `plugin update`, `plugin uninstall` (a plugin's data is kept unless `--delete-data`) and `plugin prune`. Plugin loading (`plugins.enabled`) is offered after a yes and never turned on silently; `--enable-loading` does it. Nothing is downloaded: addresses that need a download exit 69. Nothing changes for existing plugins; to use the new commands, add a marketplace folder or install a plugin folder.
