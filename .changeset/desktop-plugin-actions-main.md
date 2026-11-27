---
'@namzu/desktop': patch
---

The app's main process learns the plugin and marketplace methods of the engine (a `pluginsManage` capability group), reads their answers through checked readers, and opens a plugin file dialog (`.zip` or `.plugin`, up to 200 MB, checked for the zip signature) and a folder dialog through the same path registry as skills.
