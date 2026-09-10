# @namzu/google

Native Google Gemini GenerateContent provider for the Namzu SDK. Supports Gemini API keys and an existing Gemini CLI OAuth account through Code Assist. This package owns transport, not login or credential storage.

```ts
import { GoogleProvider } from '@namzu/google'

const provider = new GoogleProvider({ apiKey: process.env.GEMINI_API_KEY })
for await (const chunk of provider.chatStream({
  model: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

For Gemini CLI accounts, supply `getAccessToken(signal)` instead of `apiKey`. The host callback must refresh expired tokens and honor cancellation. Optional `projectId` selects an already configured Code Assist project; otherwise `loadCodeAssist` discovers the current account's managed project. Uninitialized accounts must complete setup in Gemini CLI: Namzu never automatically enrolls an account or selects a billing tier.

Configuration also accepts `timeoutMs` (120 seconds by default), a `fetch` implementation, and a host-level `model` hint. Each `chatStream` request's model is authoritative. API keys go to Google's Generative Language API; OAuth tokens only go to Google's Code Assist endpoint. HTTP error bodies are not exposed because they may contain account information.

The driver streams text, thinking summaries and function calls; retains signed native response parts for unchanged, same-route tool history; maps inline image/document inputs and tool results; and maps native JSON Schema output. Unsupported explicit controls fail before transport. Gemini 2.5 accepts manual thinking budgets, not a fabricated low/high effort menu. Known Gemini 3 Flash and Pro families expose their documented thinking levels. Unknown models have no inferred menu.

API-key model listing uses Google's live generation-model catalogue. Code Assist has no equivalent public catalogue: its conservative menu (Gemini 2.5 Flash and Pro) is a set of candidates, not proof of account entitlement. Additional explicit model IDs can be sent directly to `chatStream`. Prices are standard text/image [API reference prices](https://ai.google.dev/gemini-api/docs/pricing), in USD per million tokens, not subscription billing; Pro's reference is for prompts up to 200k tokens. For live models without established prices, numeric price fields use the SDK's existing zero sentinel for unknown; this is not a free-tier claim and must not be treated as a billing estimate. Credential probing is separate from listing. Authentication and a particular model's entitlement still require a successful server request.

Transport contracts follow [Google's thought-signature guidance](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures), [thinking controls](https://ai.google.dev/gemini-api/docs/generate-content/thinking), and the [Gemini CLI Code Assist source](https://github.com/google-gemini/gemini-cli/tree/main/packages/core/src/code_assist). Runtime-neutral history from another provider cannot preserve Google's native signatures.
