---
title: Provider Selection Guide
description: Detailed decision guide for choosing the right published Namzu provider package by deployment model, vendor fit, dependency shape, and local-vs-cloud tradeoffs.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/openai", "@namzu/anthropic", "@namzu/bedrock", "@namzu/openrouter", "@namzu/http", "@namzu/ollama", "@namzu/lmstudio"]
---

# Provider Selection Guide

All published Namzu providers plug into the same `ProviderRegistry`, but they are not interchangeable in purpose. This page is the practical decision guide for choosing the right package before you start wiring runtime code.

## 1. Start With the Deployment Model

| Deployment reality | Best first choice |
| --- | --- |
| Direct OpenAI usage | `@namzu/openai` |
| Direct Anthropic usage | `@namzu/anthropic` |
| AWS-native environment with Bedrock access | `@namzu/bedrock` |
| Multi-vendor routing through one account | `@namzu/openrouter` |
| Generic or self-hosted OpenAI-compatible endpoint | `@namzu/http` |
| Local Ollama daemon | `@namzu/ollama` |
| Local LM Studio server | `@namzu/lmstudio` |

## 2. Choose by What You Want to Optimize

| Optimize for | Prefer | Why |
| --- | --- | --- |
| Smallest translation to OpenAI | `@namzu/openai` | Uses the vendor SDK directly |
| Smallest translation to Anthropic | `@namzu/anthropic` | Uses the vendor SDK directly |
| AWS auth, IAM, and region semantics | `@namzu/bedrock` | Speaks Bedrock natively |
| One account for many vendors | `@namzu/openrouter` | Unified catalog and billing |
| Lowest conceptual dependency surface | `@namzu/http` | Pure fetch and explicit dialect |
| Local open-model workflow with Ollama | `@namzu/ollama` | Native Ollama client |
| Local open-model workflow with LM Studio | `@namzu/lmstudio` | Official LM Studio SDK transport |

## 3. Tool and Streaming Expectations

| Package | Declared tool support | Streaming | Notes |
| --- | --- | --- | --- |
| `@namzu/openai` | Yes | Yes | Strong default for general-purpose tool agents |
| `@namzu/anthropic` | Yes | Yes | Strong default for Anthropic-native tool agents |
| `@namzu/bedrock` | Yes | Yes | Good when tool-capable models are enabled in Bedrock |
| `@namzu/openrouter` | Yes | Yes | Depends on chosen upstream model |
| `@namzu/http` | Yes | Yes | Actual endpoint must implement the expected dialect correctly |
| `@namzu/ollama` | Conservative `false` | Yes | Tool behavior varies by selected model |
| `@namzu/lmstudio` | Yes | Yes | Real behavior still depends on the loaded model |

## 4. When `@namzu/http` Is the Right Answer

Choose `@namzu/http` when:

- the endpoint is compatible but not worth a dedicated Namzu package
- you are targeting self-hosted inference such as vLLM or TGI
- you want one generic path for many compatible backends
- you prefer explicit `dialect: 'openai' | 'anthropic'` behavior over vendor SDK coupling

Do not choose it when:

- you want Bedrock-native auth or region semantics
- you want the Ollama or LM Studio native SDK behavior instead of their compatibility layers

## 5. Local Model Decision

For local models:

| If you already use... | Prefer |
| --- | --- |
| Ollama daemon and pulled models | `@namzu/ollama` |
| LM Studio UI and loaded local models | `@namzu/lmstudio` |
| OpenAI-compatible local HTTP only | `@namzu/http` |

## 6. Common Decision Patterns

### 6.1 Smallest path to a first production cloud agent

- `@namzu/sdk`
- `@namzu/openai` or `@namzu/anthropic`

### 6.2 AWS-internal deployment

- `@namzu/sdk`
- `@namzu/bedrock`

### 6.3 Vendor-flexible product

- `@namzu/sdk`
- `@namzu/openrouter`

### 6.4 Self-hosted or gateway-heavy stack

- `@namzu/sdk`
- `@namzu/http`

### 6.5 Local development or offline experiments

- `@namzu/sdk`
- `@namzu/ollama` or `@namzu/lmstudio`

## 7. Safe Default Recommendation

If you do not yet have a strong platform constraint:

1. start with `@namzu/openai` or `@namzu/anthropic`
2. validate your runtime architecture
3. move to `@namzu/openrouter`, `@namzu/bedrock`, or `@namzu/http` only when deployment reality demands it

This keeps the early setup simple while preserving the ability to swap providers later through the registry.

## Related

- [Providers Overview](./README.md)
- [OpenAI Provider](./openai.md)
- [Anthropic Provider](./anthropic.md)
- [Bedrock Provider](./bedrock.md)
- [HTTP Provider](./http.md)
