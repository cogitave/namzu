---
title: Bedrock Provider
description: Configure @namzu/bedrock for AWS Bedrock Converse API usage with Namzu.
last_updated: 2026-07-12
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
  supportsAbortSignal: true,
}
```

## 9. Error Handling and Cancellation

`chat()` and `chatStream()` failures are normalized to the SDK's `ProviderRequestError` with a runtime-classifiable `kind` — `throttle`, `context_overflow`, `auth`, `bad_request`, `server`, `network`, `aborted`, or `unknown`. AWS throttling exceptions map to `kind: 'throttle'`, and retry-after headers are read into `retryAfterMs`, which the runtime's retry loop honors in place of its computed backoff.

The AWS SDK's internal retry loop is **disabled**, so the SDK's `retry.maxAttempts` bounds the number of requests that physically reach the network. A direct `provider.chat()` call outside the agent loop therefore performs exactly one request.

`supportsAbortSignal` is `true`: `params.signal` is forwarded to the transport, so a cancel aborts an in-flight request rather than waiting for the next iteration boundary.

The assistant tool-call argument reparse is guarded against malformed JSON, so a truncated or malformed Converse tool block cannot crash the run.

See [Reliability and Cancellation](../sdk/runtime/reliability.md).

## 10. Operational Notes

- If you do not pass explicit credentials, the AWS SDK default credential chain is used.
- Model access in Bedrock is region-specific, so enable the models you need in the target AWS region before testing.
- The provider also implements `listModels()` and `healthCheck()`.
- Bedrock model identifiers differ from direct vendor identifiers, so keep your runtime model config Bedrock-specific.

## 11. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: bedrock` | registration never happened | call `registerBedrock()` first |
| auth failures | AWS credentials were not resolved | pass explicit credentials or fix the AWS default chain |
| model unavailable in region | Bedrock access is not enabled in that region | enable the model in Bedrock and use the correct region |
| `ProviderRequestError` with `kind: 'auth'` | credentials rejected | terminal — not retried. Fix the credential chain |
| `ProviderRequestError` with `kind: 'throttle'` | AWS throttling exception | retried automatically inside an agent run; honor `retryAfterMs` on direct calls |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [Anthropic Provider](./anthropic.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [Bedrock Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/bedrock/src/index.ts)
- [Bedrock Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/bedrock/src/types.ts)
