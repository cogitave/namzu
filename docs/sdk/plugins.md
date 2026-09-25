---
type: Reference
title: Plugin toolsets and lifecycle
description: File and in-code plugins, source ownership, MCP servers, request context and revocation.
resource: packages/sdk/src/plugin/lifecycle.ts
tags: [sdk, plugins, toolsets, mcp]
---

# Plugin toolsets and lifecycle

`PluginLifecycleManager` owns one deferred file-tool source per installed plugin (`plugin:<name>`) and one deferred MCP source per declared server (`plugin:<name>/mcp:<server>`). These entries exist at install time, so a host can include `manager.toolsets` in its `ToolManager` once and observe later enable/disable changes through `onChange`. File tool names remain `<plugin>__<tool>`. MCP tools use `<plugin>__mcp__<server>__<tool>`; prompts use `<plugin>__mcp__<server>__prompt__<name>`. Plugin MCP servers use [`mcpToolset`](mcp-toolset.md), including policy-filtered resources, live discovery and held changed definitions.

A JavaScript tool module must export a `tools` array of complete tool
definitions. Each tool needs a Zod `inputSchema`; a compatible parser
with an explicit `modelInputSchema` also works. An invalid tool is refused
when the plugin is enabled, naming its plugin and module, before a deferred
tool can be revealed to the model.

The file-based `plugin.json` may include `instructions` as a nonempty string. They reach the model as labelled, untrusted `context` only while the plugin is enabled. `manager.promptContributions` lists current entries for a host to register with its turn's `PromptContributionRegistry`. Disabling a plugin unregisters its entry; an already-running turn's copy also renders nothing after disable. Enabling it again restores the contribution. Tool, skill and hook contributions follow the same lifecycle; disabling closes MCP toolsets before disconnecting their clients.

For a plugin supplied by host code, `definePlugin({ name, tools, hooks, instructions, mcpServers })` validates and snapshots the declaration. Optional `version` defaults to `0.0.0`; optional `description` defaults to `In-code plugin <name>`. Install it with `manager.installDefined(plugin, scope?)`, then call `manager.enable(id)`, `disable(id)` and `uninstall(id)` as for a file plugin. `scope` defaults to `project`; no manifest file or dynamic import is read for an in-code plugin. `mcpServers` uses the same stdio server config as a file manifest. Hosts still own admission of the code they pass in.

```ts sketch
const plugin = definePlugin({
  name: 'audit',
  tools: [auditTool],
  hooks: [{ event: 'pre_tool_use', handler: auditHook }],
  instructions: 'Explain the audit evidence before acting.',
})
const installed = manager.installDefined(plugin)
await manager.enable(installed.id)
const toolsets = manager.toolsets
for (const contribution of manager.promptContributions) promptContributions.register(contribution)
await manager.disable(installed.id)
```
