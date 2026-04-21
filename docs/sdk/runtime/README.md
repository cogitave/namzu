---
title: Runtime
description: Reference map for the runtime building blocks exposed by @namzu/sdk.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# SDK Runtime

The SDK exports a broad runtime surface, but the pieces follow a consistent shape: providers supply model calls, agents orchestrate runs, registries and managers own definitions plus lifecycle, and stores persist mutable state.

## 1. Runtime Map

| Area | Main exports | Use it when you need... |
| --- | --- | --- |
| Providers | `ProviderRegistry`, `LLMProvider` types | A vendor-neutral model boundary |
| Agents | `ReactiveAgent`, `PipelineAgent`, `RouterAgent`, `SupervisorAgent` | Different execution patterns over the same runtime |
| Low-level kernel | `query`, `drainQuery` | Direct control over event streaming, verification, sandboxing, and runtime-only features |
| Lifecycle | `AgentManager`, `RunPersistence`, `EmergencySaveManager`, `PlanManager` | Run orchestration, persistence, and review hooks |
| Replay (v1) | `listCheckpoints`, `prepareReplayState`, `MutationNotApplicableError` | Fork an existing run from a checkpoint, optionally mutating the fork point — see [Replay](./replay.md) |
| Stores | `RunDiskStore`, `DiskTaskStore`, conversation and memory stores | Local durability for runtime data |
| Session hierarchy | `InMemorySessionStore`, `DiskSessionStore`, handoff, summary, workspace, retention exports | Tenant-scoped project and delegation state |
| Sandboxing | `LocalSandboxProvider`, `SandboxProviderFactory` | Isolated command execution |
| Persona and skills | `SkillRegistry`, `assembleSystemPrompt`, `mergePersonas`, `withSessionContext` | Stable prompt composition and reusable instructions |
| Retrieval | `DefaultKnowledgeBase`, `DefaultRetriever`, `createRAGTool` | Retrieval-augmented context |
| Plugins and registries | `PluginRegistry`, `ToolRegistry`, `AgentRegistry`, `PluginLifecycleManager` | Extensibility and catalog-style registration |
| Connectors and MCP | `ConnectorRegistry`, `ConnectorManager`, `MCPClient`, `MCPToolDiscovery`, `MCPConnectorBridge`, `MCPServer` | External system integration and MCP interoperability |
| Wire bridges | `mapRunToStreamEvent`, A2A helpers | Observability ships from [`@namzu/telemetry`](https://www.npmjs.com/package/@namzu/telemetry) as of 0.4.0 |
| Plugin runtime | `PluginLifecycleManager`, `discoverPlugins`, `loadPluginManifest`, `PluginResolver` | Namespaced extensions, hook execution, and plugin-managed MCP tools |

## 2. Agent Families

The public agent classes are distinct runtime shapes rather than separate products:

| Agent class | Intended role |
| --- | --- |
| `ReactiveAgent` | General-purpose tool-using loop |
| `PipelineAgent` | Sequential staged execution |
| `RouterAgent` | Route to a target path or downstream agent based on input |
| `SupervisorAgent` | Coordinate or delegate across sub-agents |

If you are starting fresh, begin with `ReactiveAgent` unless you already know you need routing or supervision.

## 3. Provider Boundary

Every provider package plugs into the same `LLMProvider` contract:

- `chat(params)` returns a normalized completion result.
- `chatStream(params)` yields normalized stream chunks.
- `listModels()` and `healthCheck()` are optional.

This is why you can swap provider packages without rewriting agent setup code.

Read [Provider Operations](../provider-integration/operations.md) if you want direct provider-call patterns instead of the agent loop.

## 4. Persistence and Local State

The SDK exports both in-memory and disk-backed implementations so you can start simple and add durability later:

| Surface | Examples |
| --- | --- |
| Generic store | `InMemoryStore` |
| Runs and checkpoints | `RunDiskStore` |
| Tasks | `InMemoryTaskStore`, `DiskTaskStore` |
| Conversation state | `InMemoryConversationStore` |
| Memory | `InMemoryMemoryIndex`, `InMemoryMemoryStore`, `DiskMemoryStore` |

## 5. When to Add Optional Capability Packages

The SDK is intentionally not the only published package in the system:

- Add a provider package when you need a real model backend.
- Add `@namzu/computer-use` when your tool registry needs screenshots or desktop input.
- Stay on the SDK alone if you are building mocks, tests, or package-level abstractions first.

## 6. Architecture Deep Dives

If you are implementing against the SDK rather than only consuming the public API, use the architecture set alongside this runtime page:

| If you need to understand... | Read |
| --- | --- |
| Why each top-level folder exists | [Folder Reference](../architecture/folder-reference.md) |
| Provider registration and provider creation | [Provider Registry](../provider-integration/registry.md) |
| Direct provider calls and preflight methods | [Provider Operations](../provider-integration/operations.md) |
| Agent class selection and delegation boundaries | [SDK Agents](../agents/README.md) |
| Personas, skill files, and prompt layering | [SDK Prompting](../prompting/README.md) |
| Knowledge-base ingestion and retrieval tools | [SDK Retrieval](../retrieval/README.md) |
| Project-session-sub-session persistence and archival | [SDK Sessions](../sessions/README.md) |
| Required IDs and identity mapping | [Runtime Identities](./identities.md) |
| Agent config and runtime limits | [Runtime Configuration](./configuration.md) |
| `query()` and `drainQuery()` wiring | [Low-Level Runtime](./low-level.md) |
| Plugin manifests, namespacing, and hook order | [Plugins and MCP Servers](../integrations/plugins.md) |
| The shipped tool set | [Built-In Tools](../tools/built-in.md) |
| Verification, plan mode, and sandbox behavior | [Tool Safety](../tools/safety.md) |
| Connector lifecycle and MCP bridging | [Connectors and MCP](../integrations/connectors-and-mcp.md) |
| SSE and A2A wire mapping | [Event Bridges](../integrations/event-bridges.md) |
| Telemetry startup and metrics | [SDK Observability](../observability/README.md) |
| Foundation modules such as `types/` and `constants/` | [Foundation Folders](../architecture/foundation-folders.md) |
| Agent execution, `runtime/`, `manager/`, and `compaction/` | [Execution Folders](../architecture/execution-folders.md) |
| `session/`, `store/`, and `gateway/` boundaries | [Session and Store Folders](../architecture/session-and-store-folders.md) |
| Providers, connectors, bridges, tools, plugins, personas, and RAG | [Integration Folders](../architecture/integration-folders.md) |

## Related

- [SDK Overview](../README.md)
- [SDK Architecture](../architecture/README.md)
- [Provider Registry](../provider-integration/registry.md)
- [Provider Operations](../provider-integration/operations.md)
- [SDK Agents](../agents/README.md)
- [SDK Prompting](../prompting/README.md)
- [SDK Retrieval](../retrieval/README.md)
- [SDK Sessions](../sessions/README.md)
- [Runtime Configuration](./configuration.md)
- [Low-Level Runtime](./low-level.md)
- [Connectors and MCP](../integrations/connectors-and-mcp.md)
- [Plugins and MCP Servers](../integrations/plugins.md)
- [Event Bridges](../integrations/event-bridges.md)
- [SDK Observability](../observability/README.md)
- [Tool Safety](../tools/safety.md)
- [SDK Quickstart](../quickstart.md)
- [Providers Overview](../../providers/README.md)
- [Computer Use](../../computer-use/README.md)
- [SDK Package Entry](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/index.ts)
