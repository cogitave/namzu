---
title: Providers Overview
description: Compare the published Namzu provider packages and choose the right integration path for your runtime.
last_updated: 2026-07-12
status: current
related_packages: ["@namzu/sdk", "@namzu/openai", "@namzu/anthropic", "@namzu/bedrock", "@namzu/openrouter", "@namzu/http", "@namzu/ollama", "@namzu/lmstudio"]
---

# Providers Overview

Namzu keeps provider implementations outside `@namzu/sdk`, but every published provider package plugs into the same `ProviderRegistry` and `LLMProvider` contract. The practical question is not how to wire the runtime, but which provider package best matches your deployment reality.

## 1. Choose a Provider

| Package | Best fit | Notable strength |
| --- | --- | --- |
| [`@namzu/openai`](./openai.md) | Direct OpenAI usage | Official SDK integration with `baseURL` overrides |
| [`@namzu/anthropic`](./anthropic.md) | Direct Anthropic usage | Native Anthropic Messages API |
| [`@namzu/bedrock`](./bedrock.md) | AWS-native deployments | AWS credential-chain support and Bedrock Converse API |
| [`@namzu/openrouter`](./openrouter.md) | Multi-vendor model access | One account, many vendors, zero extra runtime dependency |
| [`@namzu/http`](./http.md) | Generic compatible endpoints | Zero-dependency fallback for OpenAI- or Anthropic-shaped APIs |
| [`@namzu/ollama`](./ollama.md) | Local Ollama daemon | Local-first open model workflows |
| [`@namzu/lmstudio`](./lmstudio.md) | Local LM Studio server | Official LM Studio SDK integration |

## 2. Shared Registration Pattern

Every provider page follows the same runtime shape:

1. install `@namzu/sdk` and one provider package
2. call the provider package's `register...()` helper once at startup
3. create the provider through `ProviderRegistry.create({ type: ..., ... })`
4. pass the returned `provider` into an agent config or call `provider.chat()` directly

## 3. Capability Snapshot

| Package | Tools | Streaming | Abort signal | Notes |
| --- | --- | --- | --- | --- |
| `@namzu/openai` | Yes | Yes | Yes | Strong default for general-purpose cloud agents |
| `@namzu/anthropic` | Yes | Yes | Yes | Anthropic-native behavior |
| `@namzu/bedrock` | Yes | Yes | Yes | Best when auth and governance already live in AWS |
| `@namzu/openrouter` | Yes | Yes | Yes | Depends on chosen upstream model |
| `@namzu/http` | Yes | Yes | Yes | Endpoint must match declared dialect correctly |
| `@namzu/ollama` | Conservative `false` | Yes | **No** (non-streaming) | Tool behavior depends on chosen model |
| `@namzu/lmstudio` | Yes | Yes | Yes | Loaded model still determines practical quality |

The **abort signal** column is `ProviderCapabilities.supportsAbortSignal`: whether a
cancel aborts an in-flight request, or only takes effect at the next iteration
boundary. Only `@namzu/ollama` declares `false`, and only on its non-streaming
path — its official client exposes no abort hook there. See
[Reliability and Cancellation](../sdk/runtime/reliability.md#6-cancellation).

## 4. Errors Are Uniform Across Packages

Whichever package you pick, a failed model call throws the same
`ProviderRequestError`, carrying a classified `kind` (`throttle`,
`context_overflow`, `auth`, `bad_request`, `server`, `network`, `aborted`,
`unknown`), the upstream `status`, and a `retryAfterMs` parsed from the vendor's
rate-limit headers when there was one.

That is what lets the runtime loop retry a 429 and compact-and-reissue on a
context overflow without knowing which vendor it is talking to — and it means
your own error handling does not have to branch by vendor either. See
[Reliability and Cancellation](../sdk/runtime/reliability.md).

## 5. Quick Routing Guide

- choose `@namzu/openai` if OpenAI is the primary target
- choose `@namzu/anthropic` if you want Anthropic-native Messages API semantics
- choose `@namzu/bedrock` if auth, region, or governance already live inside AWS
- choose `@namzu/openrouter` if vendor flexibility matters more than direct-vendor coupling
- choose `@namzu/http` if the backend is compatible but non-standard for the Namzu package lineup
- choose `@namzu/ollama` or `@namzu/lmstudio` for local model workflows

## 6. Recommended Reading Path

| If you need... | Read |
| --- | --- |
| Help choosing the package in the first place | [Provider Selection Guide](./selection-guide.md) |
| Registry-level provider wiring | [Provider Registry](../sdk/provider-integration/registry.md) |
| Direct `chat()`, `chatStream()`, `listModels()`, and `healthCheck()` usage | [Provider Operations](../sdk/provider-integration/operations.md) |
| A working first runtime example | [SDK Quickstart](../sdk/quickstart.md) |
| Detailed package-specific setup | One of the provider pages below |

## Related

- [Provider Selection Guide](./selection-guide.md)
- [Provider Operations](../sdk/provider-integration/operations.md)
- [OpenAI Provider](./openai.md)
- [Anthropic Provider](./anthropic.md)
- [Bedrock Provider](./bedrock.md)
- [OpenRouter Provider](./openrouter.md)
- [HTTP Provider](./http.md)
- [Ollama Provider](./ollama.md)
- [LM Studio Provider](./lmstudio.md)
