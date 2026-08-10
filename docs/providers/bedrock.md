---
title: Bedrock Provider
description: Configure @namzu/bedrock for AWS Bedrock Converse API usage with Namzu.
last_updated: 2026-08-11
status: current
related_packages: ["@namzu/sdk", "@namzu/bedrock"]
---

# Bedrock Provider

`@namzu/bedrock` is the AWS-native provider package for Namzu. It integrates with the Bedrock Converse API and keeps authentication aligned with standard AWS credential resolution.

## 1. When to Use It

Choose this package when your application already runs inside AWS or when your model access, regions, and credentials need to stay inside Bedrock.

## 2. When Not to Use It

Choose another provider when:

- you want direct Anthropic API semantics rather than Bedrock's Converse layer
- you are not in an AWS-oriented environment and do not benefit from IAM and region-aware behavior

## 3. Install

```bash
pnpm add @namzu/sdk @namzu/bedrock
```

## 4. Register and Create the Provider

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerBedrock } from '@namzu/bedrock'

registerBedrock()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'bedrock',
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
})
```

## 5. Sanity-Check With a Direct Provider Call

```ts
const response = await provider.chat({
  model: 'anthropic.claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
})

console.log(response.message.content)
```

## 6. Use It With a Reactive Agent

```ts
import {
  ReactiveAgent,
  ToolRegistry,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'

const agent = new ReactiveAgent({
  id: 'bedrock-agent',
  name: 'Bedrock Agent',
  version: '1.0.0',
  category: 'docs',
  description: 'Provider documentation example.',
})

const result = await agent.run(
  {
    messages: [{ role: 'user', content: 'Say hello.' }],
    workingDirectory: process.cwd(),
  },
  {
    provider,
    tools: new ToolRegistry(),
    model: 'anthropic.claude-sonnet-4-20250514',
    tokenBudget: 8_192,
    timeoutMs: 60_000,
    projectId: generateProjectId(),
    sessionId: generateSessionId(),
    tenantId: generateTenantId(),
  },
)
```

## 7. Configuration

| Field | Required | Description |
| --- | --- | --- |
| `region` | No | AWS region; can also come from the environment or AWS config |
| `accessKeyId` | No | Explicit AWS access key |
| `secretAccessKey` | No | Explicit AWS secret key |
| `sessionToken` | No | Optional AWS session token |
| `timeout` | No | Request timeout in milliseconds |

## 8. Capability Snapshot

The package exports `BEDROCK_CAPABILITIES`:

```ts
{
  supportsTools: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: false,
  supportsDocuments: false,
}
```

Images do not travel on this driver. A user attachment is not mapped into an image content block, and an image inside a tool result is replaced by a named placeholder saying what was there and how large it was — which is why `supportsVision` is `false` rather than a promise the message translation does not keep. This paragraph previously described images travelling as raw bytes, and the snapshot above previously reported `supportsVision: true`; neither was true of the package.

### Prompt caching

Caching is requested when the caller sets `cacheControl` **and** the model is one Anthropic serves through Converse. The driver then emits three cache points:

| Cache point | Placement | Omitted when |
| --- | --- | --- |
| tool schemas | after the last `toolSpec` in `toolConfig.tools` | the caller passes no tools |
| static system text | after the last system message tagged `cacheHint: 'cache'` | no system message is tagged static |
| conversation prefix | after the last content block of the last non-empty message | never, when caching is on |

The prompt is assembled tools → system → messages, so each later point also covers every section before it.

The model condition is not a formality. Converse is a multi-vendor wire, and prompt caching is a property of the models on it rather than of the wire, so a request carrying a cache point to a model that does not accept one is rejected outright. A model outside the gate therefore sends exactly the bytes it sends today, uncached, and `cacheControl` has no effect on it.

Cache hits and writes are reported separately from ordinary input, as `cachedTokens` and `cacheWriteTokens` on the usage of every turn. Those counters were always mapped correctly — for a period the driver reported them while requesting no caching at all, so they read a truthful zero, and a caller could not distinguish "caching does not help this workload" from "caching was never asked for". A run with caching on and a stable prefix should show `cachedTokens` rising after the first turn; if it stays at zero, the prefix is changing rather than the caching being off.

## 9. Operational Notes

- If you do not pass explicit credentials, the AWS SDK default credential chain is used.
- Model access in Bedrock is region-specific, so enable the models you need in the target AWS region before testing.
- The provider also implements `listModels()` and `healthCheck()`.
- Bedrock model identifiers differ from direct vendor identifiers, so keep your runtime model config Bedrock-specific.

## 10. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: bedrock` | registration never happened | call `registerBedrock()` first |
| auth failures | AWS credentials were not resolved | pass explicit credentials or fix the AWS default chain |
| model unavailable in region | Bedrock access is not enabled in that region | enable the model in Bedrock and use the correct region |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [Anthropic Provider](./anthropic.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [Bedrock Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/bedrock/src/index.ts)
- [Bedrock Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/bedrock/src/types.ts)
