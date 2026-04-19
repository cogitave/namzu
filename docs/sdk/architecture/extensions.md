---
title: Extensions and Integrations
description: How @namzu/sdk exposes providers, connectors, plugins, personas, skills, tools, and RAG as extension surfaces.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/computer-use"]
---

# Extensions and Integrations

Much of the SDK's size comes from the number of extension surfaces it supports. The important architectural point is that these are not random optional modules; they are organized so external integrations attach through explicit registries, factories, or interface contracts.

## 1. Providers

The `provider/` folder is intentionally small in core:

| Module | Responsibility |
| --- | --- |
| `provider/registry.ts` | Register provider constructors and expose `ProviderRegistry.create()` |
| `provider/mock.ts` | Built-in mock provider for tests and local flows |
| `provider/mock-register.ts` | Pre-register the mock provider |
| `provider/telemetry/` | Provider-level telemetry setup |

The vendor implementations themselves live outside the SDK package. Core owns the registry and shared contract, not the concrete vendors.

## 2. Tools and Registries

Tools are one of the main extension mechanisms:

- `tools/defineTool.ts` turns a Zod schema plus executor into a `ToolDefinition`.
- `tools/builtins/` ships first-party tools such as file, shell, search, structured output, and computer-use tool wrappers.
- `tools/task/`, `tools/advisory/`, `tools/memory/`, and `tools/coordinator/` build domain-specific tool sets.
- `registry/tool/execute.ts` owns `ToolRegistry`, availability state, prompt conversion, and execution dispatch.

Architecturally, the important split is:

```text
tools/       -> tool construction
registry/    -> tool catalog and execution boundary
runtime/     -> when and how tools are exposed to the model
```

## 3. Connectors and MCP

The `connector/` folder is a large integration surface because it combines definitions, execution contexts, and MCP support:

| Area | Responsibility |
| --- | --- |
| `BaseConnector.ts` | Core connector abstraction |
| `builtins/` | Built-in HTTP and webhook connectors |
| `execution/` | Local, remote, and hybrid execution contexts |
| `mcp/` | MCP client, server, transports, discovery, and adapter helpers |

The SDK also exposes MCP translation in `bridge/mcp/connector/adapter.ts`, which turns connector methods into MCP tools.

## 4. Bridges

`bridge/` is where protocol translation lives:

| Bridge area | Responsibility |
| --- | --- |
| `bridge/a2a/` | Agent-to-agent protocol translation |
| `bridge/mcp/` | MCP-facing translation |
| `bridge/sse/` | Mapping `RunEvent`s to SSE wire events |
| `bridge/tools/` | Tool-facing bridge helpers |

These modules are adapters. They should translate and map, not become a second ownership layer for business rules.

## 5. Plugins

`plugin/` is the SDK's general runtime extension surface:

- `loader.ts` discovers plugin directories and manifests.
- `resolver.ts` resolves plugin wiring.
- `lifecycle.ts` runs plugin hooks over runtime phases.

The runtime pipeline calls into the plugin lifecycle at defined hook points instead of letting plugins patch arbitrary runtime internals.

## 6. Personas and Skills

The prompt-construction side of the SDK is split cleanly:

| Folder | Responsibility |
| --- | --- |
| `persona/` | Merge personas and assemble system-prompt layers |
| `skills/` | Discover, load, and resolve skill chains |

This matters because prompt identity and skill procedures are treated as separate concepts, even though both eventually contribute to the prompt surface seen by the model.

## 7. Advisory and RAG

Two advanced extension surfaces live alongside the main runtime:

| Folder | Responsibility |
| --- | --- |
| `advisory/` | Advisor registry, trigger evaluation, and advisor execution |
| `rag/` | Chunking, embeddings, vector store, retriever, knowledge base, and `createRAGTool()` |

Both surfaces integrate with the main runtime without changing the basic provider-plus-tools architecture.

## 8. Computer Use Fits as a Tool Contract

The SDK does not implement desktop control directly. Instead:

- `types/computer-use/` defines `ComputerUseHost`, action types, result types, and capability types.
- `tools/builtins/computer-use.ts` turns any `ComputerUseHost` into the `computer_use` tool.
- `@namzu/computer-use` provides the concrete host implementation.

This is a strong example of the SDK's extension philosophy: core owns the contract and tool integration, while a separate published package owns the environment-specific implementation.

## Related

- [SDK Tools](../tools/README.md)
- [Computer Use](../../computer-use/README.md)
- [Safety and Operations](./safety.md)
- [Provider Registry](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/provider/registry.ts)
- [Connector Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/connector/index.ts)
