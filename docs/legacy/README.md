---
title: Namzu Documentation
description: Entry point for the published Namzu docs covering the SDK, computer-use package, and provider packages.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/computer-use", "@namzu/openai", "@namzu/anthropic", "@namzu/bedrock", "@namzu/openrouter", "@namzu/http", "@namzu/ollama", "@namzu/lmstudio"]
---

# Namzu Documentation

This directory is the publishable documentation surface for Namzu. It is written for direct use on `docs.namzu.ai`, covers only packages that are currently shipped, and intentionally excludes local-only or ignored workspace content.

## 1. Start Here

Use this documentation if you are building on the published Namzu packages:

| Area | Package | What it covers |
| --- | --- | --- |
| Core runtime | `@namzu/sdk` | Agents, tools, provider registration, runtime building blocks, stores, and extension points |
| Desktop control | `@namzu/computer-use` | Screenshot, mouse, and keyboard control through a `ComputerUseHost` |
| Providers | `@namzu/*` | OpenAI, Anthropic, Bedrock, OpenRouter, HTTP, Ollama, and LM Studio integrations |

Ignored and unpublished workspace areas are intentionally excluded from this docs surface.

## 2. Documentation Map

| Section | Purpose |
| --- | --- |
| [Getting Started](./getting-started.md) | Choose packages, install them, and make the first successful call |
| [SDK Overview](./sdk/README.md) | Understand what lives in `@namzu/sdk` and how its parts fit together |
| [SDK Runtime](./sdk/runtime/README.md) | Runtime map plus IDs, configuration, and low-level execution entrypoints |
| [SDK Agents](./sdk/agents/README.md) | Agent classes, orchestration, and delegation boundaries |
| [SDK Tools](./sdk/tools/README.md) | Tool definition, built-in tools, and tool-safety policy |
| [SDK Provider Integration](./sdk/provider-integration/README.md) | SDK-level provider registry and direct provider operations |
| [SDK Prompting](./sdk/prompting/README.md) | Skills, personas, and prompt composition |
| [SDK Retrieval](./sdk/retrieval/README.md) | Knowledge bases, retrieval, and RAG tool exposure |
| [SDK Sessions](./sdk/sessions/README.md) | Project-session-sub-session lifecycle, workspaces, and retention |
| [SDK Integrations](./sdk/integrations/README.md) | Connectors, MCP, plugins, and bridge surfaces |
| [SDK Observability](./sdk/observability/README.md) | Telemetry and instrumentation surfaces |
| [SDK Architecture](./sdk/architecture/README.md) | Understand the internal folder boundaries and recurring patterns inside `@namzu/sdk` |
| [SDK Quickstart](./sdk/quickstart.md) | Run a minimal reactive agent with a real provider |
| [Computer Use](./computer-use/README.md) | Add desktop control to a Namzu tool registry |
| [Computer Use Action Reference](./computer-use/action-reference.md) | Inspect the full `computer_use` action contract |
| [Computer Use Host Lifecycle](./computer-use/host-lifecycle.md) | Understand host initialization, capabilities, and disposal |
| [Platform Support](./computer-use/platform-support.md) | Review OS support, permissions, and operational caveats |
| [Providers](./providers/README.md) | Compare provider packages and route to the right integration page |
| [Provider Selection Guide](./providers/selection-guide.md) | Choose the right provider package by deployment model, dependency shape, and local-vs-cloud tradeoffs |

## 3. Recommended Reading Order

1. Read [Getting Started](./getting-started.md) to pick the package set you need.
2. Read [SDK Quickstart](./sdk/quickstart.md) once you are ready to run an agent.
3. Read [Provider Selection Guide](./providers/selection-guide.md) before choosing a production provider package.
4. Read [SDK Runtime](./sdk/runtime/README.md) before diving into individual runtime fields.
5. Read [SDK Agents](./sdk/agents/README.md) when you need more than the one-agent quickstart path.
6. Read [SDK Tools](./sdk/tools/README.md) before exposing a real tool surface to models.
7. Read [SDK Provider Integration](./sdk/provider-integration/README.md) if you need registry-level provider wiring or direct provider calls.
8. Read [SDK Integrations](./sdk/integrations/README.md) if the runtime needs external systems, MCP interoperability, or plugin-managed tools.
9. Read [SDK Sessions](./sdk/sessions/README.md) before persisting project or delegation state.
10. Read [SDK Observability](./sdk/observability/README.md) if you need production tracing or metrics.
11. Read [SDK Architecture](./sdk/architecture/README.md) if you are extending or contributing to the SDK internals.
12. Read [Computer Use](./computer-use/README.md) only if your agent needs desktop interaction.

## 4. Documentation Conventions

These docs follow a simple publishing model so they work both in-repo and on a static docs site:

- Every page includes structured frontmatter for indexing and freshness tracking.
- Every page uses numbered sections so page structure is easy to parse visually and by tools.
- Every page ends with a `Related` section that links to adjacent docs and source material.
- Examples use the public package surfaces that are exported today.

## Related

- [Getting Started](./getting-started.md)
- [SDK Overview](./sdk/README.md)
- [SDK Runtime](./sdk/runtime/README.md)
- [SDK Agents](./sdk/agents/README.md)
- [SDK Tools](./sdk/tools/README.md)
- [SDK Provider Integration](./sdk/provider-integration/README.md)
- [SDK Prompting](./sdk/prompting/README.md)
- [SDK Retrieval](./sdk/retrieval/README.md)
- [SDK Sessions](./sdk/sessions/README.md)
- [SDK Integrations](./sdk/integrations/README.md)
- [SDK Observability](./sdk/observability/README.md)
- [SDK Architecture](./sdk/architecture/README.md)
- [Providers Overview](./providers/README.md)
- [Provider Selection Guide](./providers/selection-guide.md)
- [Repository Root](https://github.com/cogitave/namzu)
