---
'@namzu/cli': minor
---

A plugin in the common layout that names a hooks module in `hooks/hooks.json` now has it run, in an isolated worker, for as long as the plugin is on. Before it runs you are told what it does: the trust screen lists it with the events it hooks and whether it runs commands, reads files or uses the network, and `namzu plugin validate` prints the same lines plus each pattern and call (the `--json` report gains an optional `hooksModule`). A module that cannot load is said once at launch and the plugin's other parts still load; a hook of a module that fails refuses the tool call it guards. The trust screen now also lists the hook entries of a common-layout plugin that has no `plugin.json`. Nothing existing breaks; a plugin that ships only `.js` hooks under its own `plugin.json` still runs them in the process. `plugins.enabled`, your saved yes for the plugin and a hooks switch still decide whether anything starts.
