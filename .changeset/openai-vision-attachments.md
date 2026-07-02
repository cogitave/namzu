---
'@namzu/openai': patch
---

Map user-message image attachments to OpenAI `image_url` content parts.

`toOpenAIMessages` now converts `UserMessage.attachments` into
multimodal content parts (text first, then each image as an
`image_url` part carrying a `data:<mediaType>;base64,<data>` URI),
mirroring the Anthropic driver's image-block mapping. Previously
attachments were silently dropped. The driver declares
`supportsVision: true` and exposes its capabilities on the provider
instance for the SDK's capability negotiation.
