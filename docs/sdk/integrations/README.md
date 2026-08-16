---
uid: namzu.sdk.integrations.readme
title: Integrations
description: Overview of connector, MCP, plugin, and bridge surfaces in @namzu/sdk.
type: Guide
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-04-18T00:00:00Z
lastReviewed: 2026-04-18
tags: [sdk]
---

# Integrations

This folder groups the SDK surfaces that let Namzu connect to external systems, consume or publish MCP capabilities, and adapt runtime events to other protocols.

## 1. What This Folder Covers

| Page | Purpose |
| --- | --- |
| [Connectors and MCP](./connectors-and-mcp.md) | Connector lifecycle, remote MCP tool consumption, and MCP publishing helpers |
| [Plugins and MCP Servers](./plugins.md) | Plugin discovery, namespaced tools, hooks, and plugin-managed MCP servers |
| [Event Bridges](./event-bridges.md) | SSE and A2A event mapping for wire-level interoperability |

## 2. How to Navigate It

Use these pages in this order:

1. start with [Connectors and MCP](./connectors-and-mcp.md) if you are integrating external systems
2. move to [Plugins and MCP Servers](./plugins.md) if integrations are plugin-driven
3. finish with [Event Bridges](./event-bridges.md) if runtime events must be exposed to external clients

## Related

- [Connectors and MCP](./connectors-and-mcp.md)
- [Plugins and MCP Servers](./plugins.md)
- [Event Bridges](./event-bridges.md)
