---
'@namzu/sdk': minor
---

A plugin manifest may now declare `platforms` (for example `["linux", "darwin"]`) and `engines.namzu` (a version range such as `">=60.0.0 <62"`). A plugin that does not support the running operating system or Namzu version is refused when its manifest is read, with a message naming what it needs and what this machine has. Additive: manifests that declare neither load exactly as before, and `PluginEnablementCapabilities` gains optional `platform` and `namzuVersion` for hosts that want to supply their own.
