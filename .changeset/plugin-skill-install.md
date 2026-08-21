---
'@namzu/sdk': minor
---

Allow `PluginLifecycleManager.install()` to admit manifest-declared skills when the manager owns a `SkillRegistry`, so the supported `install → enable` lifecycle reaches the model without hosts fabricating registry records. `loadPluginManifest()` now accepts an optional, fail-closed `PluginEnablementCapabilities` argument for hosts that call the loader directly.
