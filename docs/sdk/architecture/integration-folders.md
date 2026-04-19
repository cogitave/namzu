---
title: Integration Folders
description: Deep reference for providers, connectors, bridges, plugins, personas, skills, tools, advisory, and RAG inside @namzu/sdk.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/computer-use"]
---

# Integration Folders

The SDK is designed to stay vendor-neutral and environment-neutral while still being extensible. The integration layer is where that philosophy becomes concrete.

## 1. What This Layer Owns

These folders answer a common architectural question: "how does core attach to outside systems without letting them take over the runtime?"

The answer is:

- use narrow contracts
- register capabilities explicitly
- translate protocols at dedicated bridge boundaries
- keep environment-specific implementations outside the core when possible

## 2. `provider/`

`provider/` keeps the core provider surface intentionally small.

### 2.1 What It Contains

| Area | Responsibility |
| --- | --- |
| `registry.ts` | Register provider constructors and create instances |
| `mock.ts` and `mock-register.ts` | Built-in mock provider support |
| `telemetry/setup.ts` | Provider-level telemetry wiring |

### 2.2 Why It Is Small

The SDK owns provider contracts and provider registration. Concrete vendors belong in published provider packages. That keeps the core runtime stable even when vendor ecosystems change.

## 3. `connector/`

`connector/` is the SDK's generic external-system integration surface.

### 3.1 Connector Subfolders

| Area | Responsibility | Why it matters |
| --- | --- | --- |
| `BaseConnector.ts` | Base connector abstraction | Gives all connectors a stable runtime contract |
| `builtins/` | First-party HTTP and webhook connectors | Ships common integration surfaces without vendor lock-in |
| `execution/` | Local, remote, and hybrid execution contexts plus factory | Keeps execution mode separate from connector definitions |
| `mcp/` | MCP client, server, transports, discovery, and connector adapters | Makes MCP a first-class connector ecosystem inside the SDK |

### 3.2 Why Connectors Are Not Just Tools

Tools are callable model surfaces. Connectors are reusable external-system capabilities that can later be exposed as tools, MCP resources, or other runtime surfaces. That is why connectors have their own domain.

## 4. `bridge/`

`bridge/` is where the SDK translates internal shapes into external protocols.

### 4.1 Bridge Subfolders

| Area | Responsibility |
| --- | --- |
| `a2a/` | Agent-to-agent cards, messages, tasks, and state mapping |
| `mcp/connector/` | MCP connector bridge from connector methods to MCP tool surfaces |
| `sse/` | Mapping run and session events to SSE stream events |
| `tools/connector/` | Turn connectors into tool families and routing helpers |

### 4.2 Why Bridges Matter

Bridge code should translate, not redefine ownership. If a rule belongs to runtime, connector, or session logic, it should stay there. The bridge exists so protocols remain explicit and replaceable.

## 5. `plugin/`

`plugin/` is the general-purpose runtime extension system.

| Module | Responsibility |
| --- | --- |
| `loader.ts` | Discover plugin manifests and plugin directories |
| `resolver.ts` | Resolve plugin contributions and wiring |
| `lifecycle.ts` | Execute plugin hooks at defined runtime stages |

Why it is separate:

- plugins need a controlled lifecycle
- extension points must stay explicit
- the runtime should call hooks, not be monkey-patched by plugins

## 6. `persona/` and `skills/`

These two folders both affect prompt behavior, but they solve different problems.

| Folder | Responsibility | Why it is separate |
| --- | --- | --- |
| `persona/` | Assemble and merge prompt identity layers | Persona is about who the agent is |
| `skills/` | Discover, load, register, and resolve skill chains | Skills are about reusable procedures and guidance |

This split keeps prompt identity distinct from operational instruction bundles.

## 7. `rag/`

`rag/` owns retrieval as a coherent subsystem:

- chunking
- embeddings
- ingestion
- vector storage
- retrieval
- knowledge-base assembly
- `createRAGTool()`

Why it is separate:

- retrieval has its own pipeline and vocabulary
- it should integrate with runtime without becoming the runtime
- storage and retrieval concerns differ from provider and session concerns

## 8. `advisory/`

`advisory/` is the SDK's meta-reasoning subsystem.

| Module area | Responsibility |
| --- | --- |
| `registry.ts` | Register advisors |
| `evaluator.ts` | Decide when an advisor should trigger |
| `executor.ts` | Run advisor execution |
| `context.ts` | Advisory execution context |

Why it is separate:

- advisory logic reasons about the run rather than being the main run
- triggers, budgeting, and evaluation are their own concern

## 9. `tools/`

`tools/` is the construction layer for tool definitions and tool families.

### 9.1 Tool Subfolders

| Area | Responsibility |
| --- | --- |
| `defineTool.ts` | Canonical tool-definition authoring helper |
| `builtins/` | First-party filesystem, shell, search, structured output, and computer-use tool surfaces |
| `task/` | Task-oriented tool family |
| `memory/` | Memory save, read, and search tools |
| `advisory/` | Tool surfaces for advisory features |
| `coordinator/` | Coordination-oriented tools for higher-level orchestration |

### 9.2 Why `tools/` Is Separate From `registry/tool/`

`tools/` builds tool definitions. `registry/tool/` catalogs and executes them. `runtime/` decides when the model can see them. That three-way split is one of the most important patterns in the SDK.

## 10. Computer Use as a Reference Example

The `computer_use` flow demonstrates the extension model clearly:

1. `types/computer-use/` defines the host contract.
2. `tools/builtins/computer-use.ts` wraps that host as a tool.
3. `@namzu/computer-use` provides the concrete host implementation.

That is exactly how the SDK wants environment-specific behavior to plug in: contract in core, implementation in a published extension package.

## Related

- [Extensions and Integrations](./extensions.md)
- [SDK Tools](../tools/README.md)
- [Folder Reference](./folder-reference.md)
- [Connector Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/connector/index.ts)
- [Provider Registry](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/provider/registry.ts)
