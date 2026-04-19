---
title: Provider Integration
description: Overview of the SDK-level provider integration surface in @namzu/sdk, covering registry wiring and direct provider operations.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Provider Integration

This folder covers the provider-facing surfaces that belong to `@namzu/sdk` itself. It is separate from the published provider-package pages under [Providers Overview](../../providers/README.md), which document vendor-specific packages such as `@namzu/openai` or `@namzu/anthropic`.

## 1. What This Folder Covers

| Page | Purpose |
| --- | --- |
| [Provider Registry](./registry.md) | Register provider implementations, create normalized provider instances, and inspect capability metadata |
| [Provider Operations](./operations.md) | Call `chat()`, `chatStream()`, `listModels()`, and `healthCheck()` directly without jumping into an agent loop |

## 2. When to Read This Folder

Read this section when you are:

- wiring provider creation into an SDK runtime
- building boot-time provider validation flows
- adding direct provider-call paths for admin or health endpoints
- documenting the provider abstraction rather than one vendor package

If you need to choose a concrete provider package first, start with [Providers Overview](../../providers/README.md).

## Related

- [Provider Registry](./registry.md)
- [Provider Operations](./operations.md)
- [Providers Overview](../../providers/README.md)
- [SDK Runtime](../runtime/README.md)
- [SDK Overview](../README.md)
