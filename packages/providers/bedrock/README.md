# @namzu/bedrock

AWS Bedrock LLM provider for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk). Thin wrapper around `@aws-sdk/client-bedrock-runtime` exposing Bedrock's **Converse API** (chat + streaming) with full tool-use support, conformant to the `LLMProvider` contract.

## Install

```bash
pnpm add @namzu/sdk @namzu/bedrock
```

`@namzu/bedrock` declares `@namzu/sdk` as a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerBedrock } from '@namzu/bedrock'

// Register once at app startup.
registerBedrock()

// Fully typed via module augmentation: ProviderConfigRegistry['bedrock'].
const { provider, capabilities } = ProviderRegistry.create({
  type: 'bedrock',
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
})

const response = await provider.chat({
  model: 'anthropic.claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

Streaming:

```ts
for await (const chunk of provider.chatStream({
  model: 'anthropic.claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

## Authentication

Credentials resolve in this order:

1. Explicit `accessKeyId` + `secretAccessKey` (+ optional `sessionToken`) on the config object.
2. AWS SDK default credential chain — environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`), shared config/credentials files (`~/.aws/credentials`), IAM role (EC2/ECS/Lambda), SSO profiles.

If you pass neither, the SDK's default chain runs — useful for EC2/ECS/Lambda where the instance role provides credentials automatically.

### Region

Either set `region` on the config or rely on `AWS_REGION` / `AWS_DEFAULT_REGION` env var. Bedrock is region-scoped; Claude and Nova models are available in different regions. See [AWS Bedrock model regions](https://docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html).

### Model access

Bedrock requires explicit model access enablement in the AWS console. Enable the models you plan to call at **AWS Console → Bedrock → Model access → Enable specific models**.

## Capabilities

```ts
import { BEDROCK_CAPABILITIES } from '@namzu/bedrock'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
// }
```

## Observability

This package ships without observability hooks in `0.1.x`. OpenTelemetry span emission and structured logging are roadmapped for the forthcoming `@namzu/telemetry` package — a separate opt-in dependency that wraps any `LLMProvider` to emit GenAI semantic-convention spans. Track progress in the [Namzu roadmap](https://github.com/cogitave/namzu).

## License

FSL-1.1-MIT. Same as `@namzu/sdk`.
