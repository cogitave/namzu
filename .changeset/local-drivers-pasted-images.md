---
'@namzu/ollama': minor
'@namzu/lmstudio': minor
'@namzu/http': minor
---

A picture you paste now reaches a local model that reads pictures, instead of being replaced by a note.

Ollama sends a message's pictures in its `images` array, and a tool result's pictures on the tool message. Whether a model reads them comes from Ollama's own model information (`capabilities` lists `vision`), read once per model and kept; a model whose information has no vision gets a short "image omitted" note, and a server that does not say counts as reading pictures. LM Studio attaches pictures as files the SDK prepares from the bytes, and reads the loaded model's vision flag from the SDK, also kept. `OLLAMA_CAPABILITIES` and `LMSTUDIO_CAPABILITIES` now declare `supportsVision` and `supportsToolResultImages` as `true`; both drivers still send no tool schemas.

`@namzu/http` sends pictures only when you opt in, because a generic endpoint cannot say which of its models read them and a text-only server usually refuses an image part. Set `vision: true` (every model) or `vision: ['llava']` (the named models, with or without a `:tag`) in the config. On the `openai` dialect a picture becomes an `image_url` data-URL part, and a tool result's picture goes in a user message right after that turn's tool messages, naming the tool call; on the `anthropic` dialect it becomes a base64 image block, also inside a tool result. Without `vision` nothing changes: the picture is left out and the notice says the model cannot see images.
