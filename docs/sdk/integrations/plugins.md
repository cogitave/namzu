---
title: Plugins and MCP Servers
description: Load project or user plugins in @namzu/sdk, register namespaced tools, execute hooks, and mount plugin-managed stdio MCP servers.
last_updated: 2026-07-12
status: current
related_packages: ["@namzu/sdk"]
---

# Plugins and MCP Servers

The plugin runtime is the SDK's project- and user-scoped extension system. It does three practical things today:

- loads namespaced tool modules
- runs hook modules over runtime phases
- starts stdio MCP servers declared by plugins and adapts their tools into the local tool registry

## 1. What the Plugin Runtime Owns Today

The public plugin surface is centered on:

| Export | Responsibility |
| --- | --- |
| `discoverPlugins()` / `discoverAllPluginDirs()` | Find plugin directories |
| `loadPluginManifest()` | Read and validate `plugin.json` |
| `PluginLifecycleManager` | Install, enable, disable, and uninstall plugins |
| `PluginResolver` | Resolve namespaced plugin components |
| `PluginRegistry` | Hold installed plugin definitions and statuses |

The runtime currently supports these manifest contribution types:

- `tools`
- `hooks`
- `mcpServers`

The runtime currently rejects these manifest contribution types at enable time:

- `skills`
- `connectors`
- `personas`

That fail-fast behavior is intentional. It is better to deny unsupported contributions clearly than to half-load a plugin and leave the runtime in an ambiguous state.

## 2. Discovery Paths and Manifest File

The plugin discovery constants point at:

- project scope: `<workingDirectory>/.namzu/plugins/<plugin-name>/plugin.json`
- user scope: `~/.namzu/plugins/<plugin-name>/plugin.json`

Minimal manifest example:

```json
{
  "name": "docs-tools",
  "version": "0.1.0",
  "description": "Project-specific Namzu tools and hooks",
  "tools": ["./tools.js"],
  "hooks": ["./hooks.js"],
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "node",
      "args": ["./mcp/filesystem-server.js"],
      "env": {
        "WORKSPACE_ROOT": "/workspace"
      }
    }
  ]
}
```

Manifest rules that matter operationally:

- `name` must be lowercase kebab-case
- `plugin.json` is validated eagerly when loaded
- contribution arrays are capped by plugin-level limits in the SDK constants
- MCP server names must be legal name components (see [Tool Naming](#3-tool-naming-and-namespacing))

### `env` interpolation

`env` values on an `mcpServers` entry expand `${VAR}` and `${env:VAR}` against
the process environment, so a manifest can reference a credential without
embedding it:

```json
"env": {
  "GITHUB_TOKEN": "${GITHUB_TOKEN}",
  "LITERAL_TEXT": "$${NOT_A_VAR}"
}
```

- `$${VAR}` is an escape that yields the literal text `${VAR}`.
- A reference to a variable that is **not set** throws at `enable()` rather than
  expanding to an empty string. A blank API key should stop the enable, not
  surface later as an opaque auth failure from the MCP server.
- **`command` and `args` are not interpolated.** The stdio transport logs them
  verbatim at connect time, and a credential does not belong in a log line.
- `EnvInterpolationError` never includes the offending value. Its message lands
  on the plugin registry record, on `plugin_error`, and in the error log — a
  value echoed there would put a live token in all three. The env key names the
  manifest line, which is enough to fix it.

## 3. Tool Naming and Namespacing

A plugin's contributions are namespaced so they cannot collide with local or
built-in tools. The separator is `__`:

| Contribution | Composed name |
| --- | --- |
| Plugin `docs-tools`, tool `summarize_workspace` | `docs-tools__summarize_workspace` |
| Plugin `fs-plugin`, MCP server `fs`, remote tool `read_file` | `fs-plugin__fs__read_file` |

The composed name is the name the model sees and calls, so it must be a name a
provider will accept: `[a-zA-Z0-9_-]`, at most 64 characters. That is why the
separator is `__` and not `:` — strict providers reject `:` in a function name.

**Each component must match `^[a-zA-Z0-9_-]+$` and may not contain `__`.** Single
underscores stay legal (`read_file` is fine); only the doubled form is reserved.
That exclusion is what makes composition injective: `(fs, read_file)` gives
`fs__read_file` and `(fs_read, file)` gives `fs_read__file`, and neither can be
confused for the other when split back apart.

Names are validated and length-checked **before** the enable transaction starts
registering anything, so a bad name cannot leave a plugin half-registered. A
plugin that fails to enable is left in `error` status rather than silently back
in `installed`.

> **Upgrading from `0.4.x`:** the separator was `:`, and the old form is **not**
> resolved — a `:` name is simply an unknown tool. See
> [Migrating to 0.5.0](../../migration/0.5.md#section-a--the-plugin-namespace-separator-is-__).

### Names the plugin author does not control

A plugin author can rename their own plugin, their own tools, and their MCP
server aliases, so those are validated strictly. They cannot rename a tool that
lives inside someone else's MCP server — so those leaf names are **canonicalized**
instead of rejected:

```ts
import { canonicalizeToolName } from '@namzu/sdk'

canonicalizeToolName('notion.search')  // 'notion_search'
canonicalizeToolName('db:query')       // 'db_query'
```

The mapping is deterministic and stable across restarts, and the remote server is
still invoked under its original name. A single nonconforming remote tool name no
longer makes the whole plugin un-enableable.

## 4. Bootstrap the Plugin Runtime

```ts
import {
  PluginRegistry,
  ToolRegistry,
  PluginLifecycleManager,
  discoverAllPluginDirs,
  getRootLogger,
} from '@namzu/sdk'

const pluginRegistry = new PluginRegistry()
const toolRegistry = new ToolRegistry()
const pluginManager = new PluginLifecycleManager({
  pluginRegistry,
  toolRegistry,
  log: getRootLogger(),
})

const pluginDirs = await discoverAllPluginDirs(process.cwd())

for (const pluginDir of pluginDirs.project) {
  const plugin = await pluginManager.install(pluginDir, 'project')
  await pluginManager.enable(plugin.id)
}
```

This gives you one important invariant:

- installation records the plugin definition
- enabling loads and registers the contributions

Those are intentionally separate lifecycle steps.

## 5. Tool Modules

A plugin tool module must export a `tools` array:

```ts
import { defineTool } from '@namzu/sdk'
import { z } from 'zod'

export const tools = [
  defineTool({
    name: 'summarize_workspace',
    description: 'Summarize the workspace state for the current run.',
    inputSchema: z.object({}),
    category: 'analysis',
    permissions: [],
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    async execute() {
      return {
        success: true,
        output: 'workspace summary placeholder',
      }
    },
  }),
]
```

When enabled, plugin tools are registered as deferred and namespaced:

- manifest name `docs-tools`
- tool name `summarize_workspace`
- final registered name `docs-tools__summarize_workspace`

That namespacing keeps plugin contributions from colliding with local or built-in tools.

## 6. Hook Modules

A plugin hook module must export a `hooks` array:

```ts
export const hooks = [
  {
    event: 'pre_tool_use',
    async handler(context) {
      if (context.toolName === 'bash') {
        return { action: 'skip', reason: 'bash disabled in this environment' }
      }

      return { action: 'continue' }
    },
  },
]
```

Hook events currently available:

- `run_start`
- `run_end`
- `pre_tool_use`
- `post_tool_use`
- `pre_llm_call`
- `post_llm_call`
- `iteration_start`
- `iteration_end`

## 7. Hook Ordering and Flow Control

`PluginLifecycleManager.executeHooks()` has explicit ordering semantics:

- `pre_*` hooks run in registration order
- `post_*` hooks run in reverse order
- `modify` actions compose, so each later hook sees the previous modified input
- `error` and `skip` short-circuit further hook execution
- `resume` and `retry` also stop further hook execution

The default hook timeout is five seconds unless you override `hookTimeoutMs`.

That means plugin hooks should be fast, bounded, and deliberate. They are runtime controls, not background jobs.

### When a hook throws

A throwing or timing-out hook **blocks the operation it guards**. That is the
default, and it is deliberate: a hook that guards a tool call and then crashes
must not be read as approval.

A hook that only observes can opt out with `onError: 'continue'`:

```ts
export const hooks = [
  {
    event: 'post_tool_use',
    onError: 'continue',   // default is 'error'
    async handler(context) {
      await sendToAnalytics(context)   // a crash here must not fail the run
      return { action: 'continue' }
    },
  },
]
```

A continued error stays visible: the `plugin_hook_completed` run event carries an
`error` field whenever the handler threw, even when the policy converted the
throw into a `continue`. A crashed hook is never indistinguishable from a clean
one.

## 8. Plugin-Managed MCP Servers

Plugin manifests can declare `mcpServers`, but the runtime shape is important:

- each manifest entry becomes an `MCPClient`
- the transport is stdio-based today
- the runtime calls `listTools()` on the remote MCP server
- discovered remote tools are adapted into deferred, namespaced local tools

Example names:

- plugin name `fs-plugin`
- MCP server name `fs`
- remote tool `read_file`
- final tool name `fs-plugin__fs__read_file`

Every name for a server is composed **before** any of them is registered, so a
name that cannot be used never leaves the server half-registered.

The leaf name is canonicalized rather than validated, because it belongs to the
remote server (see [Tool Naming](#3-tool-naming-and-namespacing)). Only one
failure survives canonicalization: plugin + server + tool exceeding the
64-character provider limit, with no component this side is allowed to shorten.
That single tool is skipped with a `plugin_tool_skipped` lifecycle event — the
plugin still enables, because one unusable remote tool must not cost the operator
every other tool the plugin contributes.

## 9. What Plugin `mcpServers` Do Not Do

The current plugin runtime does not automatically:

- expose MCP resources or templates as local docs or tool surfaces
- use `http-sse` transport from plugin manifests
- host inbound MCP servers for other clients

The runtime path today is specifically:

1. spawn a local stdio MCP server process
2. connect as an MCP client
3. adapt remote tools into local deferred Namzu tools

## 10. Disable and Uninstall Behavior

Plugin shutdown behavior is intentionally ordered:

1. disconnect plugin-managed MCP clients
2. unregister namespaced tools
3. remove hook handlers
4. update plugin status

This matters because it prevents new remote MCP calls from reaching a client while the tool surface is being torn down.

## 11. Resolve Namespaced Plugin Components

`PluginResolver` helps when your app needs to reason about namespaced tool names:

```ts
import { PluginResolver } from '@namzu/sdk'

const resolver = new PluginResolver(pluginRegistry, toolRegistry)

console.log(resolver.resolveToolName('docs-tools__summarize_workspace'))
console.log(resolver.getPluginTools(plugin.id))
console.log(resolver.namespaceName('docs-tools', 'summarize_workspace'))
```

`namespaceName()` validates both parts exactly as the enable path does, so it is
the right way to build a composed name. Do not concatenate by hand: a hand-built
`myplugin__read__file` is indistinguishable from the MCP form (plugin
`myplugin`, server `read`, tool `file`) and destroys the injectivity that probe
vetoes, plugin hooks, and the verification gate all depend on.

`resolveToolName()` returns `null` when no *installed* plugin owns the name. A
`__` in a name is not by itself proof of plugin ownership — nothing stops a
consumer registering `my__tool` directly — so the plugin has to be known, not
merely syntactically plausible.

This is useful for:

- admin UIs
- plugin attribution in logs
- filtering or grouping tools by plugin

## 12. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| assuming plugin tools are active immediately | plugin tools are registered as deferred by default |
| assuming `skills`, `connectors`, or `personas` contributions already work | the runtime rejects those contribution types today |
| assuming plugin `mcpServers` can be configured as HTTP/SSE endpoints | manifest-driven plugin MCP currently uses stdio transport only |
| forgetting tool names are namespaced | direct activation or filtering by bare tool name will miss plugin tools |
| using the old `:` separator | it is not resolved. A `:` name is an unknown tool — see [Migrating to 0.5.0](../../migration/0.5.md) |
| building composed names by hand | use `namespaceName()`; hand-built names can collide with the MCP form |
| putting a literal credential in an MCP `env` value | reference it as `${VAR}` so it is not committed to the manifest |

## Related

- [SDK Tools](../tools/README.md)
- [Connectors and MCP](./connectors-and-mcp.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Event Bridges](./event-bridges.md)
- [Integration Folders](../architecture/integration-folders.md)
- [Migrating to 0.5.0](../../migration/0.5.md)
- [Plugin Lifecycle Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/plugin/lifecycle.ts)
- [Plugin Types Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/plugin/index.ts)
