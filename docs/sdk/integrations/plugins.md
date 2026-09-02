---
title: Plugins and MCP Servers
description: Load project or user plugins in @namzu/sdk, register namespaced tools and skills, execute hooks, and mount plugin-managed stdio MCP servers.
type: Guide
status: stable
tags: [sdk]
generated: { by: human:bahadirarda, at: 2026-08-21T00:00:00Z }
---

# Plugins and MCP Servers

The plugin runtime is the SDK's project- and user-scoped extension system. It does four practical things today:

- loads namespaced tool modules
- loads namespaced skills into a host-owned skill registry
- runs hook modules over runtime phases
- starts stdio MCP servers declared by plugins and adapts their tools into the local tool registry

## 1. What the Plugin Runtime Owns Today

The public plugin surface is centered on:

| Export | Responsibility |
| --- | --- |
| `discoverPlugins()` / `discoverAllPluginDirs()` | Find plugin directories |
| `loadPluginManifest()` | Read and validate `plugin.json` against the host capabilities supplied to it |
| `PluginLifecycleManager` | Install, enable, disable, and uninstall plugins |
| `PluginResolver` | Resolve namespaced plugin components |
| `PluginRegistry` | Hold installed plugin definitions and statuses |

The runtime currently supports these manifest contribution types:

- `tools`
- `hooks`
- `mcpServers`
- `skills`, and only when the host wired a `SkillRegistry` — see [wiring the registry a manifest reaches](#skills-and-the-registry-they-need)

The runtime rejects these manifest contribution types outright, because no manifest path into their registries exists yet:

- `connectors`
- `personas`

The refusal lands where the manifest is **read**, not at enable: `loadPluginManifest()` checks it, and `install()` goes through `loadPluginManifest()` with the capabilities owned by that manager. Direct callers may pass a `PluginEnablementCapabilities`; omitting it preserves the fail-closed default, so a skill manifest is accepted only when the caller explicitly says it owns the registry the skill will reach. `PluginLifecycleManager.enable()` repeats the same check as a backstop for a definition that reached the registry some other way, and a plugin that trips it there moves to status `error` rather than staying `installed`.

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

## 3. Bootstrap the Plugin Runtime

```ts
import { homedir } from 'node:os'
import {
  PluginRegistry,
  ToolRegistry,
  PluginLifecycleManager,
  createLogger,
  discoverAllPluginDirs,
  prettySink,
} from '@namzu/sdk'

// Yours to build and yours to pass. There is no process-wide logger to
// inherit from: a component constructed without one emits nothing.
const log = createLogger({
  sink: prettySink(process.stderr),
  level: { current: 'info' },
  resource: { 'service.name': 'my-app' },
  scope: 'plugins',
})

const pluginRegistry = new PluginRegistry()
const toolRegistry = new ToolRegistry()
const pluginManager = new PluginLifecycleManager({
  pluginRegistry,
  toolRegistry,
  scopeRoots: {
    project: process.cwd(),
    user: homedir(),
  },
  log,
})

const pluginDirs = await discoverAllPluginDirs(process.cwd())

for (const pluginDir of pluginDirs.project) {
  const plugin = await pluginManager.install(pluginDir, 'project')
  await pluginManager.enable(plugin.id)
}
```

### The CLI host path

`@namzu/cli` can construct this lifecycle on behalf of an operator. Its
top-level `plugins` config remains disabled unless `enabled` is exactly `true`,
and it forwards `autoDiscovery`, `allowedScopes`, and `hookTimeoutMs` to the
same SDK boundaries shown here. The CLI mounts a host-owned `SkillRegistry`
and `SkillTool`, passes the manager, registry, and current skill manifest into
both fresh queries and durable resumes, and uninstalls the runtime only after
the session's live provider operations settle.

The project directory is discovered only after the CLI trust gate pins its
real path. Plugin settings cannot be selected through an environment variable
or a named profile, so ambient shell state cannot turn JavaScript imports on.
If a later plugin refuses, contributions from earlier plugins are uninstalled
in reverse order; if plugin startup refuses after ordinary MCP connectors were
opened, those connectors are closed before the candidate session is rejected.

This CLI integration currently belongs to the top-level agent session.
Delegated child agents build separate registries and do not inherit plugin
tools, skills, or hooks.

### Restricting where plugins may come from

`discoverAllPluginDirs` scans two locations: `.namzu/plugins` under the working
directory, and the same path under the user's home directory. They are not
equally trusted. A project plugin is reviewable in the repository the agent is
working on; a user plugin comes from a home directory the repository's
reviewers never see, and a plugin is arbitrary code with hooks into tool
execution.

Pass the discovery half of `PluginRuntimeConfig` to say which locations are
allowed:

```ts
import { discoverAllPluginDirs } from '@namzu/sdk'

const pluginDirs = await discoverAllPluginDirs(process.cwd(), {
  enabled: true,
  allowedScopes: ['project'],
})

// `pluginDirs.user` is empty — the home directory was never read, rather than
// read and filtered.
```

`enabled: false` or `autoDiscovery: false` discovers nothing at all. A
disallowed scope is not scanned rather than scanned and discarded: filtering
afterwards still reads the directory, and the returned count would tell the
caller how many plugins live somewhere they said they would not look.

Calling `discoverAllPluginDirs(cwd)` with no second argument scans both scopes,
which is the behaviour every existing caller already had.

Discovery and installation use the same filesystem authority. Construct the
manager with `scopeRoots.project` set to the trusted working directory and
`scopeRoots.user` set to the user home directory. `install(path, scope)`
canonicalizes `path` against the corresponding root before reading it. An
intermediate link that leaves that root, a symlinked plugin directory, and a
symlinked or non-regular `plugin.json` are refused rather than followed.

`PluginRegistry` remains a public status projection, not executable authority.
The manager keeps an immutable copy of the admitted root and manifest and uses
its own contribution ownership to decide whether a plugin is enabled. Changing
a registry record therefore cannot redirect an import, start a duplicate MCP
server, or make uninstall skip teardown. A registry record created by an older
host is re-read from disk and admitted against `scopeRoots` before it can
enable; an out-of-root record is refused. Direct manager hosts must provide
these roots when upgrading.

### Skills, and the registry they need

A manifest may declare `skills`. The manager loads each one, namespaces it the
way it namespaces tools (`ledger__reconcile`), writes the namespaced name into
the skill's own metadata so the registry key and a rendered prompt agree, and
takes it back on disable — but all of that needs somewhere to put them, so it
happens only when the manager was constructed with a `skillRegistry`:

```ts
import { homedir } from 'node:os'
import {
  PluginLifecycleManager,
  PluginRegistry,
  SkillRegistry,
  ToolRegistry,
  createLogger,
  prettySink,
} from '@namzu/sdk'

const log = createLogger({
  sink: prettySink(process.stderr),
  level: { current: 'info' },
  resource: { 'service.name': 'my-app' },
  scope: 'plugins',
})

const pluginManager = new PluginLifecycleManager({
  pluginRegistry: new PluginRegistry(),
  toolRegistry: new ToolRegistry(),
  skillRegistry: new SkillRegistry(log),
  scopeRoots: {
    project: process.cwd(),
    user: homedir(),
  },
  log,
})
```

Without one, a manifest declaring skills is **refused** rather than enabled with
its skills dropped: a plugin reporting `enabled` while contributing nothing its
author declared is the lie the whole check exists to prevent. Namespacing is not
cosmetic either — two plugins shipping a `reconcile` skill would otherwise
overwrite each other in a map keyed by the frontmatter name, and the loser would
vanish with nothing reporting it.

`install()` derives this capability from the manager's constructor-owned
`skillRegistry`, so the ordinary lifecycle path accepts the manifest only when
`enable()` has the same durable destination available. Calling
`loadPluginManifest()` directly remains fail-closed unless the caller supplies
`{ skillsSupported: true }`; that flag is an assertion about host wiring, not a
request to ignore a missing registry.

This gives you one important invariant:

- installation records the plugin definition
- enabling loads and registers the contributions

Those are intentionally separate lifecycle steps.

## 4. Tool Modules

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

That namespacing keeps plugin contributions from colliding with local or built-in tools. The separator is `__`, not `:`, for the reason spelled out in [section 7](#7-plugin-managed-mcp-servers): the name reaches the provider verbatim and a colon is outside the character set the major message APIs accept, so a colon made every plugin-contributed tool name illegal.

## 5. Hook Modules

A plugin hook module must export a `hooks` array:

```ts
import type { PluginHookDefinition } from '@namzu/sdk'

export const hooks: PluginHookDefinition[] = [
  {
    event: 'pre_tool_use',
    async handler(context) {
      if (context.toolName === 'Bash') {
        return { action: 'skip', reason: 'Bash disabled in this environment' }
      }

      return { action: 'continue' }
    },
  },
]
```

Hook events currently available:

- `run_start`
- `run_end`
- `run_interrupt`
- `pre_tool_use`
- `post_tool_use`
- `pre_llm_call`
- `post_llm_call`
- `iteration_start`
- `iteration_end`

`run_interrupt` is a root-run operator notification, not a second cancellation
policy. It runs only when the caller stops a root run with the explicit `user`
cancel cause, after cancellation has been observed and before the durable
`run_completed` event. Parent abandonment, budget exhaustion, hook refusal,
unattributed aborts, and delegated child runs do not emit it.

Every registered interrupt handler is attempted in registration order. Its
result is observational: `skip`, `retry`, `modify`, `error`, and timeout are
recorded but cannot change the cancellation or suppress a later handler. Each
handler receives `context.cancelCause === 'user'` and a fresh `context.signal`
for its own cleanup deadline. That signal is deliberately not the already
aborted run signal; plugins should forward it to cleanup I/O and treat its abort
as the end of their notification window.

### Sanitizing a tool result without failing the call

A `post_tool_use` hook returns `{ action: 'replace', output }` to change what the model sees while the call still stands as successful:

```ts
import type { PluginHookDefinition } from '@namzu/sdk'

declare function redact(text: string): string

const sanitize: PluginHookDefinition = {
  event: 'post_tool_use',
  handler: async ({ toolResult }) => {
    // `toolResult` is optional on the context type — it is the payload of the
    // tool events only — so a hook narrows it before reading through it.
    if (!toolResult) return { action: 'continue' }

    const cleaned = redact(toolResult.output)
    return cleaned === toolResult.output
      ? { action: 'continue' }
      : { action: 'replace', output: cleaned }
  },
}
```

This is the difference between the two substitution actions:

| | `error` | `replace` |
| --- | --- | --- |
| model sees | `Error: <message>` | your `output`, verbatim |
| `isError` | `true` | follows the tool — `false` on a successful call |
| rich content | dropped | **preserved** |

Before `replace` existed the only way to change an output was `error`, so redacting a credential arrived at the model as a **tool failure** — and a model told a call failed routes around it, retrying it or reporting to the user that it did not work.

Two rules worth knowing:

- **Rich content survives a replace.** The common case is redacting text from a result whose image is unaffected. A hook that needs the blocks gone passes `content: []` — and a hook redacting a secret that *also* appears in an image must, because the replace cannot inspect what it is preserving.
- **A replace cannot promote a failure.** A tool that returned `success: false` stays an error even if a hook rewrites its message. The tool decides whether the work happened; the hook decides what may be shown.

`replace` is rejected on `pre_tool_use` — there is no result to replace yet — and on the lifecycle events, loudly rather than silently, so a hook author who meant to redact something finds out instead of watching the secret go through.

### What a pre-tool hook is allowed to change

`pre_tool_use` receives the decoded, detached and deeply frozen input that
would otherwise be reviewed and executed. Mutating that object in place has no
effect. Return `{ action: 'modify', input }` to request a different input; the
runtime validates and detaches that replacement, then runs authorization and
human review against its final projection before execution.

This order is deliberate: a hook cannot change an operation after approval,
and a schema transform cannot turn an approved raw value into a different
unreviewed executable value. The registry keeps a separate private copy for
execution, so a hook retaining its visible object also retains no mutation
authority.

### What a model-call hook is shown

`pre_llm_call` carries `context.request` — the call the run is about to make — and `post_llm_call` carries `context.response`:

```ts
import type { PluginHookDefinition, RunId } from '@namzu/sdk'

declare const audit: {
  record(runId: RunId, model: string | undefined, toolNames: readonly string[] | undefined): void
}
declare const ledger: { charge(runId: RunId, tokens: number): void }

export const hooks: PluginHookDefinition[] = [
  {
    event: 'pre_llm_call',
    async handler(context) {
      // Which capabilities were exposed on this turn, and to which model.
      audit.record(context.runId, context.request?.model, context.request?.toolNames)
      return { action: 'continue' }
    },
  },
  {
    event: 'post_llm_call',
    async handler(context) {
      ledger.charge(context.runId, context.response?.usage.totalTokens ?? 0)
      return { action: 'continue' }
    },
  },
]
```

`request` is `{ model, messages, toolNames, temperature?, maxTokens? }` and `response` is `{ content, toolNames, finishReason, usage }`. Both are projections of the real request and reply, not the wire objects: driver-specific parameters stay out of the plugin contract, and tools appear as names because an audit asks which capabilities were offered, not what their schemas look like.

Both are **read-only** and frozen. A hook that reshaped the request would change what every later hook sees, so the outcome would depend on installation order and the last plugin registered would silently win. Shaping a call is the job of `prepareStep`, which has a single slot and one writer by contract. The messages are frozen copies, so a write cannot reach the run's history.

## 6. Hook Ordering and Flow Control

`PluginLifecycleManager.executeHooks()` has explicit ordering semantics:

- handlers are held in `priority` order, lower first, ties keeping registration order — `priority` defaults to 100
- `pre_*` hooks run in that order
- `post_*` hooks run in reverse of it
- `modify` actions compose, so each later hook sees the previous modified input
- `error` and `skip` short-circuit further hook execution
- `retry` also stops further hook execution

`priority` is what makes a guard a guard. Because `skip` and `error`
short-circuit, a hook that denies a dangerous command only gets to deny it if
it runs before whatever else stops the chain — and installation order is
neither declared nor stable. Convention is guards below 100, observers above.

The default hook timeout is five seconds unless you override `hookTimeoutMs`.

The `context.signal` passed to every hook combines that deadline with the
owning run's cancellation signal. A signal already aborted starts no hook. If
Stop arrives while a hook is pending, the runtime stops waiting immediately,
settles the run as cancelled rather than as a plugin failure, and publishes no
completed-hook event for the abandoned result. The same run-owned signal is
used at all eight hook sites, including tool and model calls.

That signal is a cooperative boundary for the plugin's own code. Namzu can
stop awaiting an in-process JavaScript promise, but it cannot kill JavaScript
that deliberately ignores cancellation. Hook I/O must forward
`context.signal`, and code that publishes an external side effect must check it
again after an await. A late return value is ignored; an uncooperative side
effect cannot be revoked without moving the plugin into a worker or process.

That means plugin hooks should be fast, bounded, cancellation-aware, and
deliberate. They are runtime controls, not background jobs.

## 7. Plugin-Managed MCP Servers

Plugin manifests can declare `mcpServers`, but the runtime shape is important:

- each manifest entry becomes an `MCPClient`
- the transport is stdio-based today
- an `MCPReconnectSupervisor` watches each client, so a transport that drops is retried instead of taking the plugin's tools out for the life of the process
- what the server advertises goes through `MCPToolDiscovery`, which applies the per-server `mcpToolPolicies` the host passed to `PluginLifecycleManager` and reports a changed tool set through `onMCPToolDrift`
- admitted remote tools are adapted into deferred, namespaced local tools
- the server's prompts pass the same gate and are adapted into tools too — a server publishing a prompt is the same trust question as one publishing a tool

Example names:

- plugin name `fs-plugin`
- MCP server name `fs`
- remote tool `read_file`
- final tool name `fs-plugin__mcp__fs__read_file`
- a prompt named `summarize` on the same server: `fs-plugin__mcp_prompt_fs_summarize`

That naming scheme is intentional and collision-resistant. Prompts carry their own prefix because a server may publish a prompt and a tool under one name, and collapsing the two would let whichever registered second silently replace the first.

The separator is `__` and every part of the name must match
`[a-zA-Z0-9_-]`, up to 64 characters total. This is not a style
preference: the name reaches the provider verbatim, the major message APIs
accept only that character set, and they reject the **whole request** for
one bad name rather than skipping that tool. The registry refuses a name
outside the pattern at registration, where it can still say which tool is
at fault — a deferred tool with an illegal name would otherwise fail the
request at the moment something activated it, with nothing naming the
culprit.

## 8. What Plugin `mcpServers` Do Not Do

The current plugin runtime does not automatically:

- expose MCP **resources** as local docs or tool surfaces (prompts are exposed — see [section 7](#7-plugin-managed-mcp-servers))
- use `http-sse` transport from plugin manifests
- host inbound MCP servers for other clients

The runtime path today is specifically:

1. spawn a local stdio MCP server process
2. connect as an MCP client, and keep the connection supervised
3. adapt the tools and prompts that clear the server's policy into local deferred Namzu tools

## 9. Disable and Uninstall Behavior

Plugin shutdown behavior is intentionally ordered:

1. stop the reconnect supervisors
2. disconnect plugin-managed MCP clients
3. unregister namespaced tools
4. unregister namespaced skills
5. remove hook handlers
6. update plugin status

Steps 1 and 2 are in that order because a disconnect a supervisor is still watching looks exactly like a transport that dropped, so a supervisor left attached reconnects what the teardown just closed. Disconnecting before step 3 is what prevents new remote MCP calls from reaching a client while the tool surface is being torn down. The same sequence runs as rollback when `enable()` fails partway, so a plugin never half-contributes.

## 10. Resolve Namespaced Plugin Components

`PluginResolver` helps when your app needs to reason about namespaced tool names:

```ts
import { PluginResolver } from '@namzu/sdk'
import type { PluginDefinition, PluginRegistry, ToolRegistry } from '@namzu/sdk'

declare const pluginRegistry: PluginRegistry
declare const toolRegistry: ToolRegistry
declare const plugin: PluginDefinition

const resolver = new PluginResolver(pluginRegistry, toolRegistry)

console.log(resolver.resolveToolName('docs-tools__summarize_workspace'))
console.log(resolver.getPluginTools(plugin.id))
console.log(resolver.namespaceName('docs-tools', 'summarize_workspace'))
```

This is useful for:

- admin UIs
- plugin attribution in logs
- filtering or grouping tools by plugin

## 11. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| assuming plugin tools are active immediately | plugin tools are registered as deferred by default |
| assuming `connectors` or `personas` contributions already work | the runtime rejects those contribution types today, when the manifest is read |
| assuming `skills` load without a `SkillRegistry` on the manager | a manifest declaring skills is refused rather than enabled with the skills dropped |
| assuming plugin `mcpServers` can be configured as HTTP/SSE endpoints | manifest-driven plugin MCP currently uses stdio transport only |
| forgetting tool names are namespaced | direct activation or filtering by bare tool name will miss plugin tools |

## Related

- [SDK Tools](../tools/defining-tools.md)
- [Connectors and MCP](./connectors-and-mcp.md)
- [Event Bridges](./event-bridges.md)
- [Plugin Lifecycle Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/plugin/lifecycle.ts)
- [Plugin Types Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/plugin/index.ts)
