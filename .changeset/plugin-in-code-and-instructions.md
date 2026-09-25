---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Plugin manifests can declare `instructions`. An enabled plugin contributes the text as labelled, untrusted request context; disabling it revokes the contribution, including for an already-running turn. SDK hosts can also call `definePlugin({ name, tools, hooks, instructions, mcpServers })` and `PluginLifecycleManager.installDefined(plugin)` to install a host-authored plugin without a manifest file or dynamic module import.
