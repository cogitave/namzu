---
"@namzu/sdk": minor
---

The warning that a provider cannot see images or read documents now comes once, with the message that carries the picture or file, instead of before every later reply in the conversation. Adds the export `estimateMessagesTokens(messages)`, the kernel's own size estimate of a message list (text, tool calls and results, pictures, documents).
