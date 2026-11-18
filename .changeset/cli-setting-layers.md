---
'@namzu/cli': minor
---

`namzu config get <key>`, `namzu config get --json` and the Desktop `namzu/config/get` method now say which layer decides a value when it is not the user file. A setting state gains `layer` (`project`, `local`, `managed` or `env`) and `effective` (the value in force), and `env` ({variable, value}) now covers every key an environment variable decides: `limits.maxResponseTokens`, `compaction.autoCompactWindowTokens`, `smallModel`, `format`, `quiet`, `disableHooks`, `modelCatalogueRefresh`, `updates.auto`, `updates.check`, `updates.channel` and `tui.fullscreen`, not only `smallModel`. The fields are added, nothing is renamed or removed; a script that reads `value` or `set` is unchanged, and `value` is still the user file's own. `readSettings` takes optional `cwd` and `managedPath`.
