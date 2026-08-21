---
uid: namzu.sdk.integrations.connectors-and-mcp
title: Connectors and MCP
description: Build connector catalogs, expose connector instances as tools, consume remote MCP servers, and bridge connected integrations back out through MCP in @namzu/sdk.
type: Guide
diataxis: how-to
owner: cogitave/namzu
status: active
timestamp: 2026-08-05T00:00:00Z
lastReviewed: 2026-08-21
tags: [sdk]
---

# Connectors and MCP

`@namzu/sdk` publishes a real interoperability surface beyond providers and tools. The connector layer manages long-lived external integrations inside Namzu, and the MCP layer adapts tool or resource surfaces across process boundaries.

## 1. The Mental Model

These surfaces are related, but they solve different problems:

| Surface | Owns | Main exports |
| --- | --- | --- |
| Provider | model calls | `ProviderRegistry`, `LLMProvider` |
| Tool | model-callable action | `defineTool`, `ToolRegistry` |
| Connector | reusable external integration with lifecycle | `ConnectorRegistry`, `ConnectorManager`, `HttpConnector`, `WebhookConnector` |
| MCP client | consume remote MCP tools and resources | `MCPClient`, `MCPToolDiscovery`, `mcpToolToToolDefinition` |
| MCP bridge/server | publish Namzu capabilities to MCP consumers | `MCPConnectorBridge`, `MCPServer`, `toolDefinitionToMCPTool` |

Rule of thumb:

- use connectors when Namzu owns the integration lifecycle
- use MCP when the integration already speaks MCP or must be published to MCP consumers

## 2. Register Connector Definitions Once

The connector registry stores definitions, not live connections:

```ts
import {
  ConnectorRegistry,
  HttpConnector,
  WebhookConnector,
} from '@namzu/sdk'

const connectorRegistry = new ConnectorRegistry()

const httpConnector = new HttpConnector()
const webhookConnector = new WebhookConnector()

connectorRegistry.register(httpConnector.toDefinition())
connectorRegistry.register(webhookConnector.toDefinition())
```

This is application bootstrap work. Do it once, then create live instances from those definitions as runtime config becomes available.

### Connector triggers are not an SDK event system

`ConnectorDefinition.triggers`, `ConnectorTrigger`, and `ConnectorEvent` are
deprecated. They were published as declarations, but the SDK has never read a
trigger, subscribed to an upstream event, emitted a `ConnectorEvent`, or
started a run from one. Registering a trigger therefore does not activate
anything in Namzu.

The declarations remain for one migration release because
`ConnectorRegistry` returns definitions verbatim. A host may legitimately
have used that registry as its own subscription metadata table and dispatched
its own `ConnectorEvent` values. That host-owned behavior continues to work in
this release, but it is not SDK behavior and will not survive the next major.

Before upgrading to that major, move the trigger and event shapes into the
host package that owns the subscriber, and store them beside the connector id
or in a separate host registry. That boundary must also own delivery
de-duplication, claim recovery, trust, and run admission. Namzu will not infer
those policies from passive connector metadata.

## 3. Create and Connect Instances

`ConnectorManager` owns the live lifecycle:

```ts
import { ConnectorManager } from '@namzu/sdk'
import type { ConnectorRegistry, HttpConnector } from '@namzu/sdk'

declare const connectorRegistry: ConnectorRegistry
declare const httpConnector: HttpConnector

const manager = new ConnectorManager({ registry: connectorRegistry })

const docsApi = await manager.createInstance(
  {
    connectorId: httpConnector.id,
    name: 'docs-api',
    auth: {
      type: 'bearer',
      credentials: {
        token: process.env.DOCS_API_TOKEN!,
      },
    },
    options: {
      baseUrl: 'https://api.example.com',
      timeoutMs: 15_000,
      maxResponseBytes: 1024 * 1024,
    },
  },
  httpConnector,
)

await manager.connect(docsApi.id)

const healthy = await manager.healthCheck(docsApi.id)
console.log(healthy)
```

Important boundaries:

- `ConnectorRegistry` knows definitions
- `ConnectorManager` knows live instances and connection state
- the concrete connector object performs the actual external I/O

### Authentication admission and tenant credentials

`ConnectorDefinition.supportedAuth` is an admission policy, not descriptive
metadata. When a definition declares schemes, `ConnectorManager`:

- rejects an explicit unsupported credential before publishing the instance
- verifies that the live connector has the same id and auth declaration as
  the registered definition
- snapshots that policy for the instance, so replacing a registry entry does
  not change an already-created connector's authority
- rechecks the effective scheme immediately before `connect`, including a
  credential attached after instance creation; no credential is the `none`
  scheme

The built-in HTTP connector accepts `none`, `api_key`, `bearer`, `basic`,
`oauth2`, and `custom`. The built-in Webhook connector accepts only `none` and
`bearer`; other schemes were previously ignored while the connector still
reported success. A custom connector may omit `supportedAuth` only when it
intentionally accepts every `AuthType`.

Method declarations are also admission contracts. Instance creation requires
the registered definition and the concrete connector to expose the same unique
method names, then captures the registered definition for the lifetime of that
instance. Replacing or mutating the registry later does not add a hidden method
or change the schemas already admitted for a live instance.

For multi-tenant hosts, a credential id is a locator, not authority. Use
`TenantConnectorManager` with a `CredentialVault`; its connection path resolves
the secret atomically under both tenant and connector scope:

```ts
import {
  ConnectorRegistry,
  InMemoryCredentialVault,
  TenantConnectorManager,
} from '@namzu/sdk'
import type { ConnectorId, ConnectorInstance, TenantId } from '@namzu/sdk'

declare const connectorRegistry: ConnectorRegistry
declare const tenantId: TenantId
declare const connectorId: ConnectorId
declare const instance: ConnectorInstance

const credentialVault = new InMemoryCredentialVault()
const tenants = new TenantConnectorManager({
  registry: connectorRegistry,
  credentialVault,
})

tenants.registerTenant({ id: tenantId, name: 'Acme' })
const credential = await tenants.storeCredential(
  tenantId,
  connectorId,
  'production bearer',
  { type: 'bearer', credentials: { token: process.env.API_TOKEN! } },
)

// The instance also belongs to tenantId and connectorId. A credential from a
// different tenant or connector is unavailable even when its id is known.
await tenants.connectWithCredential(tenantId, instance.id, credential.id)
await tenants.revokeCredential(tenantId, credential.id)
```

The raw `CredentialVault.retrieve(id)` and `revoke(id)` methods are explicit
host-authority operations. Tenant-facing code uses `retrieveForScope` and
`revokeForTenant`; custom vault implementations must make each comparison and
secret read/delete one atomic store operation. Do not implement a scoped call
as an unscoped lookup followed by a separate metadata check. Credential refs
are immutable snapshots, and the in-memory vault also copies credential maps
at its boundary so caller mutation cannot change stored authority.

## 4. Execute Connector Methods Directly

You can call connected instances without going through the tool system:

```ts
import type { ConnectorInstance, ConnectorManager } from '@namzu/sdk'

declare const manager: ConnectorManager
declare const docsApi: ConnectorInstance

const result = await manager.execute({
  instanceId: docsApi.id,
  method: 'request',
  input: {
    method: 'GET',
    path: '/status',
  },
  signal: AbortSignal.timeout(10_000),
})

console.log(result.success)
console.log(result.output)
console.log(result.durationMs)
```

`ConnectorManager.execute()` resolves the method from that captured admission
and runs its `inputSchema` asynchronously before publishing an
`action_executing` event or invoking connector I/O. Zod transforms therefore
produce the canonical value received by the connector. An unknown method or
invalid input returns a `not_started` / safe-to-retry refusal without calling
the connector.

When a successful result has an `outputSchema`, the manager validates and
transforms it before any tool, MCP bridge, or direct caller receives it. A
schema-invalid result is quarantined as `output: null`, marked
`response_received` and unsafe to retry, and does not expose the rejected body
to the next model request. Input and output parsers share the operation signal,
so an async transform cannot keep a cancelled operation alive indefinitely.

Custom `BaseConnector` subclasses that validate inside `execute()` must pass
the operation options and await the helper:

```ts sketch
const canonical = await this.validateInput(
  this.requireMethod(method),
  input,
  options,
)
```

That keeps standalone connector calls validated while recognizing the
canonical input already produced by `ConnectorManager`. Omitting `options`
would parse a managed input twice and can rerun a transform.

This is useful for:

- diagnostics
- admin backends
- boot-time validation before tools are exposed to a model

### Operation authority and finite HTTP waits

`ConnectorExecuteParams.signal` belongs to the operation, not to its input
payload. The generic connector tool, per-method tools, router tool, and a real
query all forward the run-owned signal. Direct callers can pass their own as in
the example above; health checks accept the same shape:

```ts
import type { ConnectorInstance, ConnectorManager } from '@namzu/sdk'

declare const manager: ConnectorManager
declare const docsApi: ConnectorInstance

const controller = new AbortController()
const healthy = await manager.healthCheck(docsApi.id, {
  signal: controller.signal,
})
```

`HttpConnector` and `WebhookConnector` apply these defaults:

| Boundary | Default | Scope |
| --- | ---: | --- |
| `timeoutMs` | 30,000 ms | one clock shared by fetch and response-body reads |
| `maxResponseBytes` | 2 MiB | bytes counted from the response stream before JSON/text parsing |
| health check | 5,000 ms | the complete HEAD request |

Both values must be positive integers in the platform range. The response byte
limit is enforced while streaming; `Content-Length` is only an early refusal,
because chunked or dishonest responses can omit or understate it. Crossing the
limit cancels both the body reader and the connector-owned transport. The
connector never aborts the controller supplied by its caller.

The manager also bounds custom connectors that ignore their signal. Such a
connector receives `ConnectorOperationOptions`, but cancellation cannot prove
that its remote side effect stopped. The manager therefore returns an unknown
remote outcome and refuses a late, unphased success. A custom connector that
has received response headers can preserve that stronger fact with
`metadata.remoteOutcome: 'response_received'`.

### Origin and credential boundary

The built-in HTTP connectors attach host-configured defaults and credentials
only after enforcing the configured origin:

- an HTTP `path` may be relative or an absolute URL on `baseUrl`'s origin
- a webhook `url` override may change the path, but not the configured origin
- redirects are returned, never followed automatically; every 3xx result is a
  failure and includes its `Location` when present
- model-authored `Host`, `Proxy-Authorization`, and `Proxy-Connection` headers
  are refused before fetch

To send to another origin, configure and authorize another connector instance.
Do not use a per-call URL override as an origin router.

### Remote outcome and retry safety

Local cancellation and remote cancellation are different facts. Every built-in
HTTP result exposes the phase in `metadata` (and in its structured output when
a response exists):

| `remoteOutcome` | Meaning | Retry guidance |
| --- | --- | --- |
| `not_started` | authority was withdrawn before fetch | safe |
| `unknown` | no response arrived before cancellation/deadline | GET/HEAD are safe; mutating HTTP methods and webhooks are unsafe |
| `response_received` | response status/headers arrived | use the status; a webhook remains unsafe to repeat |

A received 2xx remains a successful remote response even when its body times
out, exceeds the byte limit, or fails to parse. In that case
`bodyAvailable: false`, `body: null`, and `bodyError` explain what was lost;
the known status is not collapsed into a generic timeout. Connector tool and
MCP bridge errors add missing phase/retry guidance to the text the model sees.
Never automatically retry a result marked `retrySafety: 'unsafe'` or
`'unknown'`.

## 5. Expose Connectors as Namzu Tools

Once a connector is connected, you can adapt it into standard Namzu tools:

```ts
import {
  ToolRegistry,
  createConnectorTools,
  allConnectorTools,
} from '@namzu/sdk'
import type { ConnectorManager } from '@namzu/sdk'

declare const manager: ConnectorManager

const tools = new ToolRegistry()

// Generic gateway tools: connector_list and connector_execute
tools.register(createConnectorTools({ manager }), 'active')

// Optional: one tool per connected connector method
tools.register(allConnectorTools(manager), 'deferred')
```

Two patterns exist:

| Pattern | When it fits |
| --- | --- |
| `createConnectorTools({ manager })` | You want a small stable tool surface that routes by instance ID and method name |
| `allConnectorTools(manager)` | You want one concrete tool per connected method |

If you want one explicit router-style tool, use `createConnectorRouterTool()` or `ConnectorToolRouter`.

Per-method tools advertise the captured method `inputSchema` to the model but
use a pass-through runtime decoder; `ConnectorManager` remains the only place
that executes the method's Zod parser. This distinction matters for async and
non-idempotent transforms. The generic and router tools cannot advertise one
dynamic method schema, but they reach the same manager enforcement boundary.

## 6. Consume Remote MCP Servers Inside Namzu

Use `MCPClient` when a remote server already speaks MCP and should show up as Namzu tools:

```ts
import {
  MCPClient,
  MCPToolDiscovery,
  ToolRegistry,
} from '@namzu/sdk'

const client = new MCPClient({
  serverName: 'filesystem',
  transport: {
    type: 'stdio',
    command: 'node',
    args: ['./mcp/filesystem-server.js'],
    cwd: process.cwd(),
  },
})

await client.connect()

const discovery = new MCPToolDiscovery([client])
const remoteTools = await discovery.toToolDefinitions()

const tools = new ToolRegistry()
tools.register(remoteTools, 'active')
```

The generated tool names are prefixed as:

- `mcp_<serverName>_<toolName>`

That keeps remote MCP tools distinct from local tool definitions.

### Deciding what a server may contribute

The example above admits whatever the server offers, which puts the
**remote** side in charge of what enters the agent's tool registry — the
inversion of least privilege. A server can add a tool between two runs and
it becomes callable with nobody having agreed to it.

```ts
import { MCPToolDiscovery } from '@namzu/sdk'
import type { Logger, MCPClient } from '@namzu/sdk'

declare const client: MCPClient
declare const logger: Logger

const discovery = new MCPToolDiscovery([client], {
  policies: {
    filesystem: { allow: ['read_file', 'list_directory'] },
    '*': { deny: ['shell_exec'] },   // servers with no entry of their own
  },
  onDrift: ({ serverName, drift }) => {
    logger.warn('MCP server changed its tools', { serverName, ...drift })
  },
})
```

Deny beats allow, so a self-contradicting config resolves restrictively.
Hosts that configure no policy see no behavior change.

### Noticing a server that changes its mind

The admitted tool set is fingerprinted and compared on each discovery.
`onDrift` reports `added` / `removed` / `changed`.

The fingerprint covers each tool's **description and input schema**, not
just its name, because the attack shape is advertising something benign at
approval time and swapping its meaning afterwards — the name never moves,
so a name-only check misses it entirely. Drift compares only what policy
*admitted*, so a permanently-refused tool is not perpetual noise.

It is reported rather than blocked: a dev server legitimately changes
between runs, and only the host knows which kind it is looking at.

### Protocol negotiation

A server answers `initialize` with the version *it* will speak, which need
not be the one the client asked for. `MCPClient` refuses anything outside
`MCP_SUPPORTED_PROTOCOL_VERSIONS` and names what it can speak. An **absent**
version is tolerated — a missing field is a sloppy server, an unsupported
one is a real incompatibility.

`MCP_PROTOCOL_VERSION` is the version namzu actually implements, not the
newest one published. Advertising a version whose requirements are
unimplemented is worse than advertising an older one honestly, because the
server tailors its behavior to the claim.

### Schema fidelity

A bridged tool's schema round-trips — server JSON Schema → Zod → JSON
Schema on the wire — so anything the converter drops is dropped from what
the **model** is shown. `mcpJsonSchemaToZod` preserves nested objects (with
their own `required`), array item types, enums, `const`, `anyOf`/`oneOf`,
nullable (`type: ['string','null']`), descriptions and defaults.

MCP objects default to **closed** (`additionalProperties: false`), so the
model is not told it may invent arguments the server never declared. A
server that explicitly sets `additionalProperties: true` is honored.

**Pointers are resolved before conversion.** `$defs` + `$ref` is the default
output of several common schema generators, and a `$ref` has no direct Zod
equivalent — so an argument defined that way used to reach the model as
`{}`, with no type and no shape. Worse, the permissive node it became is
inherently optional, so a `$ref`'d field the server listed in `required`
stopped being enforced too. Local pointers are inlined first (cycles are
cut at the repeat, non-local and dangling pointers are left permissive), so
the model sees the shape the server actually declared.

**Validation keywords survive.** `pattern`, `minLength`/`maxLength`,
`minimum`/`maximum`, `exclusiveMinimum`/`exclusiveMaximum`, `multipleOf`,
`minItems`/`maxItems` and the `email` / `uri` / `uuid` / `date-time`
formats are carried onto the converted node — shown to the model *and*
enforced, so a bad argument is caught before the round trip rather than
rejected by the server one turn later. Other `format` values are advisory
in JSON Schema and are not turned into validators. `allOf` is flattened
into a single object rather than left as an intersection, because a flat
shape is what a model can read.

**Positional arrays keep their positions.** A server that spells out
`[string, number]` — in either the draft-07 form, where `items` holds a list, or
the 2020-12 one, where `prefixItems` does — used to reach the model as "an array
of anything". The positions, their types and their order were all dropped from
what the model *reads*, not merely from what is validated.

What is emitted now depends on how tightly the server pinned it:

| The server's schema | What the model gets |
| --- | --- |
| arity pinned (`minItems` equals the member count) **and** tail closed (`additionalItems: false`, `items: false`, or `maxItems` equal to the count), up to 32 members | a **tuple** |
| anything looser | a permissive array, plus `Positional array — [0] string, [1] number.` appended to its description |

The gate is narrow on purpose, and the reason is the round trip rather than
fidelity. A tool schema the receiving wire rejects fails the **entire request**,
taking down every other tool in the call — so a faithful conversion that cannot
be sent is strictly worse than a lossy one that can. A pinned, closed tuple
renders as bounded `prefixItems`, which is the one positional shape measured as
accepted and the same shape a first-party builtin already ships. Everything
looser keeps today's permissive array and carries its shape in prose instead,
appended to whatever description the server wrote rather than replacing it.

If you author these schemas, the inversion worth knowing is that positional
members **do not constrain length**. Without `minItems` a server is permitting a
*shorter* array, which a tuple cannot express — so an absent lower bound is a
reason to keep the loose form, not a detail to round up. Set `minItems` and
close the tail if you want the model to see the real signature.

**A word on what this means for a host.** Where the server pinned the arity, the
converted schema is now a tuple, so input a permissive array accepted is refused
locally. It is only ever refused where the server itself declared it invalid —
the error moves from the server's response to the local validator — but a host
driving a bridged tool directly can see a validation failure it did not see
before, and code branching on the converted type (`instanceof z.ZodArray`) takes
a different branch.

**Depth is bounded.** Conversion stops at 32 levels and leaves anything deeper
permissive. That ceiling existed before and never fired: it was compared against
in one branch that a pure array or a union never reaches, and the counter was
not passed down the array path at all, so a deeply nested schema from a remote
tool listing took the process down with a stack overflow instead.

### Declared return shapes

A server may publish an `outputSchema` alongside a tool's inputs. No
provider's tool wire format has a slot for it, so namzu appends it to the
description the model sees (`Returns (JSON Schema): …`). It is **shown,
never validated** — namzu does not check a tool's return value against it,
which is why it is carried as JSON Schema verbatim rather than rebuilt.

That rule describes a remote MCP server's declaration. A Namzu
`ConnectorMethod.outputSchema` is different: it is a host-authored Zod contract
that `ConnectorManager` enforces before adapting the result into either a
Namzu tool or an MCP response. Connector bridges also publish its rendered JSON
Schema, including non-object return shapes.

A server may also answer with `structuredContent` and omit the
compatibility text block. That payload is serialized into the tool result's
`output` when there is no text to show, and the raw
`{ content, structuredContent }` pair is always available on `result.data`
for host code. Without this the model received an empty result for a call
that had succeeded — `isError` false, content array legitimately empty, and
no diagnostic anywhere.

### Paged catalogues

`tools/list`, `resources/list` and `resources/templates/list` thread the
server's cursor to the end. A server that pages its catalogue used to
contribute only its first page: the rest were never registered, never
namespaced, never advertised, with no error and no warning — and drift
detection did not help, because it compared page one against page one. A
server whose cursor never terminates is refused after 100 pages rather than
truncated silently, since silent truncation is the failure being fixed.

## 7. Read MCP Resources and Templates

The MCP client surface is broader than tools:

```ts
import type { MCPClient } from '@namzu/sdk'

declare const client: MCPClient

const resources = await client.listResources()
const templates = await client.listResourceTemplates()

if (resources[0]) {
  const contents = await client.readResource(resources[0].uri)
  console.log(contents)
}

console.log(templates)
```

This is useful when a remote MCP server exposes documents, datasets, or templated resource URIs alongside tool calls.

## 8. Available MCP Transport Shapes

The current SDK exports these client transport shapes:

| Transport | Use it when... |
| --- | --- |
| `stdio` | The MCP server is a child process you spawn locally |
| `http-sse` | The MCP server is reachable over an HTTP-plus-SSE endpoint |
| `streamable_http` | The server speaks the Streamable HTTP transport |

### Request deadlines and cancellation

Every JSON-RPC round trip is bounded by `requestTimeoutMs` (default 30s):

```ts
import { MCPClient } from '@namzu/sdk'

const client = new MCPClient({
  serverName: 'docs-server',
  transport: { type: 'stdio', command: 'my-mcp-server' },
  requestTimeoutMs: 15_000,
})
```

The client and both HTTP transport deadlines must be positive platform-range
integers. A transport may deliberately use a shorter `timeoutMs` than the
client round-trip deadline; whichever deadline wins is reported with its exact
`TimeoutError` and asks the peer to cancel the correlated request.

This matters most on `stdio` — the default for local servers — where a
wedged server would otherwise leave callers pending forever with no error
and no `run_failed`: not a crash, just a process that stopped. In-flight
requests are also rejected when the transport closes or errors, not only
on an explicit `disconnect()`.

Direct MCP operations accept an `MCPRequestOptions` signal. The generated MCP
tool and prompt-as-tool adapters pass the run-owned tool signal automatically:

```ts
import type { MCPClient } from '@namzu/sdk'

declare const client: MCPClient

const controller = new AbortController()

const result = await client.callTool(
  'search',
  { query: 'bounded work' },
  { signal: controller.signal },
)
```

A pre-aborted signal starts no request. Once a JSON-RPC request has been
issued, cancellation or deadline expiry chooses one local terminal cause,
cleans up that request synchronously, and then:

1. stops the local wait with the caller's exact reason
2. aborts a distinct private HTTP transport signal and removes the pending id
3. makes a bounded, best-effort `notifications/cancelled` request carrying
   that id

The third step is a request to stop, not an acknowledgement. A remote tool may
already have performed a side effect, and a server may ignore or race the
notification; do not treat local cancellation as proof that remote work was
rolled back. Over stdio, a pre-aborted send writes no bytes, but after a request
line is written the protocol notification is the only cooperative stop signal.

HTTP sends and response-body reads use the same operation authority. Closing a
transport aborts its active sends. Reconnect starts a new generation: held
responses and SSE events from the old generation cannot update the new session
id or reach its handlers, and only a successful `initialize` response may set
the Streamable HTTP session id. A failed best-effort cancellation remains a
per-request failure and cannot reject concurrent sibling calls.

A server-initiated request the client does not implement
(`sampling/createMessage`, `elicitation/create`, `roots/list`) is answered
with JSON-RPC `-32601` rather than dropped, so a spec-current server does
not wait on a reply that will never come.

Typical `http-sse` config shape:

```ts
import { MCPClient } from '@namzu/sdk'

const client = new MCPClient({
  serverName: 'remote-server',
  transport: {
    type: 'http-sse',
    url: 'https://mcp.example.com',
    headers: {
      Authorization: `Bearer ${process.env.MCP_TOKEN!}`,
    },
  },
})
```

## 9. Publish Connected Connectors Back Out Through MCP

`MCPConnectorBridge` turns connected connector methods into MCP tool definitions:

```ts
import {
  MCPConnectorBridge,
  MCPServer,
  ServerStdioTransport,
} from '@namzu/sdk'
import type { ConnectorManager } from '@namzu/sdk'

declare const manager: ConnectorManager

const bridge = new MCPConnectorBridge({
  manager,
  prefix: 'docs',
})

const server = new MCPServer(
  {
    name: 'docs-connectors',
    version: '1.0.0',
  },
  {
    listTools: () => bridge.listTools(),
    callTool: (name, args) => bridge.callTool(name, args),
  },
)

await server.start(new ServerStdioTransport())
```

Which transport you can hand `start()` is the thing to understand clearly:

- `MCPServer` runs on any `MCPTransport` that accepts **inbound** MCP traffic
- the SDK ships one: `ServerStdioTransport`. It reads the streams *this* process was given, where the client-side `StdioTransport` spawns a child and talks to that child's streams — same interface, opposite end of the pipe
- on that transport **stdout belongs to the protocol**. One stray `console.log` anywhere in the process corrupts the message stream, and the client reports malformed JSON rather than anything naming the culprit. The SDK's own logger writes to stderr; keep yours there too
- the outbound client transports are separate objects: `StdioTransport`, `HttpSseTransport` and `StreamableHttpTransport`
- there is no inbound HTTP transport, so an HTTP-hosted MCP server still has to be plumbed by an app shell, framework adapter, or plugin runtime that owns that layer

So over stdio the bridge and server run as they ship; over HTTP they stay building blocks and your host process decides how inbound traffic reaches them.

When the host has cancellation authority, the bridge accepts it explicitly:

```ts
import type { MCPConnectorBridge } from '@namzu/sdk'

declare const bridge: MCPConnectorBridge
declare const name: string
declare const args: Record<string, unknown>

const controller = new AbortController()
const result = await bridge.callTool(name, args, {
  signal: controller.signal,
})
```

## 10. Conversion Helpers

The SDK also exports direct conversion helpers:

| Helper | Purpose |
| --- | --- |
| `mcpToolToToolDefinition()` | Turn a remote MCP tool into a Namzu tool |
| `toolDefinitionToMCPTool()` | Turn a Namzu tool into an MCP tool definition |
| `mcpToolResultToToolResult()` | Normalize remote MCP tool results into Namzu `ToolResult` |
| `toolResultToMCPToolResult()` | Convert Namzu tool results back into MCP result blocks |

Use these when you need custom adaptation logic rather than the higher-level discovery or bridge helpers.

## 11. Connector and MCP Patterns That Scale Well

For production usage:

1. register connector definitions once at app startup
2. create connector instances from tenant, project, or environment config
3. connect and health-check them before exposing tools
4. use generic connector tools for dynamic environments
5. use per-method tools only when the surface is narrow and stable
6. use `MCPClient` when the integration already ships as MCP
7. use `MCPConnectorBridge` only after connector instances are connected

That keeps lifecycle ownership explicit instead of mixing definitions, connection state, and tool exposure into one abstraction.

## Related

- [SDK Tools](../tools/README.md)
- [Plugins and MCP Servers](./plugins.md)
- [Event Bridges](./event-bridges.md)
- [Connector Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/connector/index.ts)
- [Connector Tool Bridge Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/connector/tools/index.ts)
