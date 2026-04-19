---
title: SDK Overview
description: Overview of the public surfaces exported by @namzu/sdk and how they fit together.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# SDK Overview

`@namzu/sdk` is the core Namzu package. It exposes the runtime primitives that stay stable across provider choices: agents, tools, stores, registries, sandboxes, RAG helpers, identifiers, and type contracts.

## 1. What Lives in the SDK

The SDK package is the place to start if you want to run agents without binding your application to a single model vendor.

| Capability | Main public surfaces |
| --- | --- |
| Agent execution | `ReactiveAgent`, `PipelineAgent`, `RouterAgent`, `SupervisorAgent`, `AgentManager` |
| Provider integration | `ProviderRegistry`, `LLMProvider`, provider-facing type contracts |
| Tool system | `defineTool`, `ToolRegistry`, `getBuiltinTools`, built-in filesystem and shell tools |
| Safety and isolation | `LocalSandboxProvider`, verification and permission-related types |
| State and persistence | `RunDiskStore`, `DiskTaskStore`, conversation and memory stores |
| Session lifecycle | `InMemorySessionStore`, `DiskSessionStore`, session hierarchy, handoff, retention |
| Prompt composition | `SkillRegistry`, `assembleSystemPrompt`, `mergePersonas`, `withSessionContext` |
| Retrieval | `TextChunker`, `DefaultRetriever`, `DefaultKnowledgeBase`, `createRAGTool` |
| Desktop integration point | `createComputerUseTool`, `ComputerUseHost` types |
| Connectors and MCP | `ConnectorRegistry`, `ConnectorManager`, `MCPClient`, `MCPToolDiscovery`, `MCPConnectorBridge` |
| Observability and wire bridges | `TelemetryProvider`, `initTelemetry`, `mapRunToStreamEvent`, A2A helpers |

## 2. What Does Not Live in the SDK

The SDK intentionally leaves vendor-specific integrations and optional capability packages outside core:

- Provider implementations live in their own packages under `@namzu/*`.
- Desktop control lives in `@namzu/computer-use`.
- Local-only workspace packages that are not published are not part of this docs surface.

This separation keeps the SDK install surface smaller and lets you compose only the pieces you actually deploy.

## 3. Core Concepts

The public package surface is easiest to understand through four concepts:

| Concept | Role |
| --- | --- |
| Provider | Supplies `chat()` and `chatStream()` through the `LLMProvider` contract |
| Agent | Owns the runtime behavior for a run and produces a result from messages plus config |
| Tool registry | Holds callable tools and controls their availability state |
| Run context | Carries model settings, IDs, working directory, and optional runtime overrides |

Three IDs are operationally important in `0.2.x` runtime usage:

- `projectId` identifies the long-lived project scope.
- `sessionId` identifies the immediate run session.
- `tenantId` identifies the isolation boundary.

## 4. SDK Docs Structure

The SDK docs are grouped by domain instead of a flat file list:

| Folder | Purpose |
| --- | --- |
| [agents/](./agents/README.md) | agent classes, orchestration, delegation, and manager-facing behavior |
| [runtime/](./runtime/README.md) | runtime overview, IDs, configuration, and low-level query entrypoints |
| [tools/](./tools/README.md) | tool definitions, built-ins, and safety policy |
| [provider-integration/](./provider-integration/README.md) | SDK-level provider registry and direct provider operations |
| [integrations/](./integrations/README.md) | connectors, MCP, plugins, and event bridges |
| [prompting/](./prompting/README.md) | skills, personas, and prompt composition |
| [retrieval/](./retrieval/README.md) | knowledge bases, retrieval, and RAG surfaces |
| [sessions/](./sessions/README.md) | session hierarchy, workspaces, summaries, and retention |
| [observability/](./observability/README.md) | telemetry and instrumentation |
| [architecture/](./architecture/README.md) | deeper source-tree and pattern-level architecture docs |

## 5. Recommended Entry Pages

Read these pages next depending on what you are doing:

| If you want to... | Read |
| --- | --- |
| Run a first agent | [SDK Quickstart](./quickstart.md) |
| Understand runtime components | [SDK Runtime](./runtime/README.md) |
| Understand provider registration and creation | [SDK Provider Integration](./provider-integration/README.md) |
| Choose the right agent class and delegation boundary | [SDK Agents](./agents/README.md) |
| Build system prompts from persona and skill files | [SDK Prompting](./prompting/README.md) |
| Add knowledge-base retrieval | [SDK Retrieval](./retrieval/README.md) |
| Persist project-session-sub-session state | [SDK Sessions](./sessions/README.md) |
| Define custom tools | [SDK Tools](./tools/README.md) |
| Integrate connectors, plugins, or MCP servers | [SDK Integrations](./integrations/README.md) |
| Configure tracing and metrics | [SDK Observability](./observability/README.md) |
| Understand folder boundaries and architecture patterns | [SDK Architecture](./architecture/README.md) |
| Pick a model integration | [Providers Overview](../providers/README.md) |
| Add desktop control | [Computer Use](../computer-use/README.md) |

## Related

- [SDK Architecture](./architecture/README.md)
- [SDK Quickstart](./quickstart.md)
- [SDK Runtime](./runtime/README.md)
- [SDK Agents](./agents/README.md)
- [SDK Tools](./tools/README.md)
- [SDK Provider Integration](./provider-integration/README.md)
- [SDK Prompting](./prompting/README.md)
- [SDK Retrieval](./retrieval/README.md)
- [SDK Sessions](./sessions/README.md)
- [SDK Integrations](./integrations/README.md)
- [SDK Observability](./observability/README.md)
- [SDK Package Entry](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/index.ts)
